// Run a ramp/hold scenario: spawn `clients` HeadlessClient instances at
// `rampPerSec` clients/second, hold for `holdSec` seconds at full count,
// then close everything and resolve with a full report.

import { HeadlessClient } from "./headless-client.js";
import { Aggregator } from "./aggregator.js";
import { ServerSampler } from "./server-sampler.js";

/**
 * @param {object} cfg
 * @param {string} cfg.url
 * @param {number} cfg.clients
 * @param {number} cfg.rampPerSec
 * @param {number} cfg.holdSec
 * @param {string} cfg.assets         "fetch" | "off"
 * @param {number|null} cfg.serverPid
 * @param {(msg:string)=>void} [cfg.log]
 * @param {(row:object)=>void} [cfg.onTick]
 */
export function runScenario(cfg) {
  const log = cfg.log ?? ((m) => console.log(m));
  const clients = [];
  const sampler =
    cfg.serverPid && Number.isFinite(cfg.serverPid)
      ? new ServerSampler(cfg.serverPid)
      : null;
  const aggregator = new Aggregator({
    clients,
    serverSampler: sampler,
    intervalMs: 1000,
    onTick: cfg.onTick,
  });

  return new Promise((resolve) => {
    let rampHandle = null;
    let holdHandle = null;
    let stopped = false;
    let nextId = 1;

    const stop = async (reason) => {
      if (stopped) return;
      stopped = true;
      log(`[runner] stopping (${reason})`);
      if (rampHandle) clearInterval(rampHandle);
      if (holdHandle) clearTimeout(holdHandle);
      aggregator.stop();

      // Close all clients; collect final snapshots BEFORE close so the
      // bytes/errors tally reflects everything received.
      const perClient = clients.map((c) => c.snapshot());
      for (const c of clients) c.close();
      // Give the WS/RTC stacks ~250 ms to flush close frames.
      await new Promise((r) => setTimeout(r, 250));

      resolve({
        config: cfg,
        started_at: new Date(aggregator.t0Ms ? Date.now() - performance.now() + aggregator.t0Ms : Date.now()).toISOString(),
        stop_reason: reason,
        series: aggregator.series,
        clients: perClient,
        summary: summarise(perClient),
      });
    };

    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));

    aggregator.start();

    const intervalMs = Math.max(1, Math.round(1000 / cfg.rampPerSec));
    log(
      `[runner] ramping to ${cfg.clients} clients at ${cfg.rampPerSec}/s ` +
        `(every ${intervalMs} ms), assets=${cfg.assets}`,
    );

    const startOne = () => {
      const id = nextId++;
      const hc = new HeadlessClient({
        id,
        url: cfg.url,
        assets: cfg.assets,
      });
      clients.push(hc);
      hc.connect().catch((err) => {
        // connect() rejections are non-fatal — they surface as a client
        // stuck in `signaling` with an error counter. The error listener
        // already records it; nothing else to do here.
        log(`[runner] client ${id} connect() rejected: ${err?.message ?? err}`);
      });
    };

    rampHandle = setInterval(() => {
      if (clients.length >= cfg.clients) {
        clearInterval(rampHandle);
        rampHandle = null;
        log(
          `[runner] ramp complete (${clients.length} clients), holding for ${cfg.holdSec}s`,
        );
        holdHandle = setTimeout(
          () => stop("hold-elapsed"),
          cfg.holdSec * 1000,
        );
        return;
      }
      startOne();
    }, intervalMs);

    // Kick off the first client immediately so t=0 has at least one
    // connection in flight rather than waiting an interval.
    startOne();
  });
}

function summarise(perClient) {
  const states = {};
  let totalBytes = 0, totalErrors = 0;
  const handshakes = [];
  for (const c of perClient) {
    states[c.state] = (states[c.state] ?? 0) + 1;
    totalBytes += c.bytes_total;
    totalErrors += c.errors;
    if (Number.isFinite(c.state_timings_ms?.streaming))
      handshakes.push(c.state_timings_ms.streaming);
  }
  handshakes.sort((a, b) => a - b);
  const p = (q) =>
    handshakes.length
      ? handshakes[Math.min(handshakes.length - 1, Math.floor(q * handshakes.length))]
      : null;
  return {
    clients: perClient.length,
    final_states: states,
    bytes_total: totalBytes,
    errors_total: totalErrors,
    handshake_ms: {
      count: handshakes.length,
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
      max: handshakes.length ? handshakes[handshakes.length - 1] : null,
    },
  };
}
