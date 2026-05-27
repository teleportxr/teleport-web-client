// Aggregator: polls every registered HeadlessClient once per tick (default
// 1 s), computes deltas vs the previous tick, and produces a per-second
// row that combines load-tool-side metrics with optional server-side
// /proc samples.

import { monitorEventLoopDelay } from "node:perf_hooks";

const STATES = ["idle", "signaling", "negotiating", "handshake", "streaming", "closed", "error"];

export class Aggregator {
  /**
   * @param {object} opts
   * @param {Array<import("./headless-client.js").HeadlessClient>} opts.clients
   * @param {import("./server-sampler.js").ServerSampler|null} [opts.serverSampler]
   * @param {number} [opts.intervalMs=1000]
   * @param {(row:object)=>void} [opts.onTick]    called after each row is built
   */
  constructor({ clients, serverSampler = null, intervalMs = 1000, onTick }) {
    this.clients = clients;
    this.serverSampler = serverSampler;
    this.intervalMs = intervalMs;
    this.onTick = onTick;

    this.series = [];
    this.t0Ms = 0;
    this.handle = null;

    // Cumulative-snapshot baselines, kept per-tick to compute deltas.
    this.prevTotals = { bytes: 0, commands: 0, payloads: 0, errors: 0 };
    this.prevWall = 0;
    this.prevCpu = process.cpuUsage();
    this.prevServer = null;
    this.evLoop = monitorEventLoopDelay({ resolution: 20 });
  }

  start() {
    this.t0Ms = performance.now();
    this.evLoop.enable();
    // Take an immediate baseline at t=0 so the first interval is correct.
    this.prevWall = performance.now();
    if (this.serverSampler) this.prevServer = this.serverSampler.sample();
    this.handle = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.evLoop.disable();
  }

  _tick() {
    const tNow = performance.now();
    const dtMs = tNow - this.prevWall;
    this.prevWall = tNow;

    // Per-client roll-up.
    const stateCounts = Object.fromEntries(STATES.map((s) => [s, 0]));
    let bytes = 0, commands = 0, payloads = 0, errors = 0;
    const handshakeMs = [];
    for (const c of this.clients) {
      const snap = c.snapshot();
      stateCounts[snap.state] = (stateCounts[snap.state] ?? 0) + 1;
      bytes += snap.bytes_total;
      commands += sumCounts(snap.commands_by_type);
      payloads += sumCounts(snap.payloads_by_type);
      errors += snap.errors;
      if (Number.isFinite(snap.state_timings_ms.streaming))
        handshakeMs.push(snap.state_timings_ms.streaming);
    }

    const dBytes = bytes - this.prevTotals.bytes;
    const dCommands = commands - this.prevTotals.commands;
    const dPayloads = payloads - this.prevTotals.payloads;
    const dErrors = errors - this.prevTotals.errors;
    this.prevTotals = { bytes, commands, payloads, errors };

    // Runner process.
    const cpu = process.cpuUsage(this.prevCpu); // delta since baseline
    this.prevCpu = process.cpuUsage();
    const cpuPctScale = dtMs > 0 ? 0.1 / dtMs : 0; // us -> pct (us/1000 / ms * 100)
    const rss = process.memoryUsage().rss;
    const evLoopP99Ms = this.evLoop.percentile(99) / 1e6;
    this.evLoop.reset();

    // Optional server /proc sample.
    let serverRow = {};
    if (this.serverSampler) {
      const cur = this.serverSampler.sample();
      if (cur && this.prevServer) {
        const dSec = (cur.ts_ms - this.prevServer.ts_ms) / 1000;
        const userDelta = cur.cpu_user_s - this.prevServer.cpu_user_s;
        const sysDelta = cur.cpu_sys_s - this.prevServer.cpu_sys_s;
        serverRow = {
          srv_cpu_user_pct: dSec > 0 ? (userDelta / dSec) * 100 : 0,
          srv_cpu_sys_pct: dSec > 0 ? (sysDelta / dSec) * 100 : 0,
          srv_rss_mb: cur.rss_kb / 1024,
          srv_vsize_mb: cur.vsize_kb / 1024,
          srv_threads: cur.threads,
        };
      }
      this.prevServer = cur;
    }

    const row = {
      t_s: (tNow - this.t0Ms) / 1000,
      ...stateCounts,
      msgs_per_s: dtMs > 0 ? ((dCommands + dPayloads) * 1000) / dtMs : 0,
      bytes_per_s: dtMs > 0 ? (dBytes * 1000) / dtMs : 0,
      d_commands: dCommands,
      d_payloads: dPayloads,
      d_errors: dErrors,
      handshake_p50_ms: percentile(handshakeMs, 0.5),
      handshake_p95_ms: percentile(handshakeMs, 0.95),
      run_cpu_user_pct: cpu.user * cpuPctScale,
      run_cpu_sys_pct: cpu.system * cpuPctScale,
      run_rss_mb: rss / (1024 * 1024),
      run_evloop_p99_ms: evLoopP99Ms,
      ...serverRow,
    };
    this.series.push(row);
    if (this.onTick) this.onTick(row);
  }
}

function sumCounts(obj) {
  let n = 0;
  for (const v of Object.values(obj)) n += v;
  return n;
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
