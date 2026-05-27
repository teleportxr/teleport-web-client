#!/usr/bin/env node
// teleport-loadtest: ramp N teleport-web-client instances at a configured
// rate against a teleport signalling server, hold, then emit per-client
// + per-second metrics.
//
// Usage:
//   node src/cli.js [flags]
// Flags:
//   --url ws://host:port      signalling URL (default ws://localhost:8081)
//   --clients N               total concurrent clients (default 10)
//   --ramp R[/s]              new clients per second (default 5/s)
//   --hold T[s]               seconds at full count after ramp (default 30s)
//   --assets fetch|off        asset-fetch behaviour (default fetch)
//   --server-pid PID          /proc/<pid> sampling for the server process
//   --out FILE.json           full report (per-client + per-second series)
//   --csv FILE.csv            per-second rollup
//   -h | --help               print this help

import "./node-shims.js";
import { runScenario } from "./runner.js";
import { writeJson, writeCsv } from "./writers.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") && a !== "-h") {
      throw new Error(`unexpected positional arg: ${a}`);
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      val = argv[++i];
    } else {
      val = "true";
    }
    out[key] = val;
  }
  return out;
}

function parseRate(s) {
  // Accept "10/s" or "10". Anything else throws.
  const m = String(s).match(/^(\d+(?:\.\d+)?)(\/s)?$/);
  if (!m) throw new Error(`invalid rate: ${s}`);
  return Number(m[1]);
}

function parseDuration(s) {
  // Accept "30", "30s". Minutes/hours not needed yet.
  const m = String(s).match(/^(\d+(?:\.\d+)?)(s)?$/);
  if (!m) throw new Error(`invalid duration: ${s}`);
  return Number(m[1]);
}

function printHelp() {
  console.log(
    `teleport-loadtest — headless scaling test for the Teleport Node server

Flags:
  --url ws://host:port    signalling URL          (default ws://localhost:8081)
  --clients N             concurrent clients      (default 10)
  --ramp R[/s]            ramp rate clients/sec   (default 5/s)
  --hold T[s]             hold seconds            (default 30s)
  --assets fetch|off      asset-fetch behaviour   (default fetch)
  --server-pid PID        sample /proc/<pid>      (optional)
  --out FILE.json         full report             (optional)
  --csv FILE.csv          per-second rollup       (optional)
  -h | --help             this help`,
  );
}

function formatTickLine(row) {
  const fmt = (n, w, d = 0) =>
    (Number.isFinite(n) ? n.toFixed(d) : "-").padStart(w);
  const parts = [
    `t=${fmt(row.t_s, 4, 0)}s`,
    `stream=${fmt(row.streaming, 4)}`,
    `negot=${fmt(row.negotiating + row.handshake + row.signaling, 4)}`,
    `err=${fmt(row.error, 3)}`,
    `msg/s=${fmt(row.msgs_per_s, 5, 0)}`,
    `KB/s=${fmt(row.bytes_per_s / 1024, 6, 1)}`,
    `runCPU=${fmt(row.run_cpu_user_pct + row.run_cpu_sys_pct, 5, 1)}%`,
    `runRSS=${fmt(row.run_rss_mb, 5, 0)}MB`,
  ];
  if (row.srv_cpu_user_pct !== undefined) {
    parts.push(
      `srvCPU=${fmt(row.srv_cpu_user_pct + row.srv_cpu_sys_pct, 5, 1)}%`,
      `srvRSS=${fmt(row.srv_rss_mb, 5, 0)}MB`,
    );
  }
  return parts.join("  ");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  const cfg = {
    url: args.url ?? "ws://localhost:8081",
    clients: Number(args.clients ?? 10),
    rampPerSec: parseRate(args.ramp ?? "5/s"),
    holdSec: parseDuration(args.hold ?? "30s"),
    assets: args.assets ?? "fetch",
    serverPid: args["server-pid"] ? Number(args["server-pid"]) : null,
  };
  if (!["fetch", "off"].includes(cfg.assets)) {
    console.error(`--assets must be 'fetch' or 'off'; got '${cfg.assets}'`);
    process.exit(2);
  }

  console.log(`[cli] cfg=${JSON.stringify(cfg)}`);
  const report = await runScenario({
    ...cfg,
    onTick: (row) => console.log(formatTickLine(row)),
  });

  if (args.out) {
    writeJson(args.out, report);
    console.log(`[cli] wrote ${args.out}`);
  }
  if (args.csv) {
    writeCsv(args.csv, report.series);
    console.log(`[cli] wrote ${args.csv}`);
  }
  console.log(`[cli] summary=${JSON.stringify(report.summary, null, 2)}`);

  // Force exit — RTC stacks can keep handles alive past close().
  setTimeout(() => process.exit(report.summary.errors_total > 0 ? 1 : 0), 200);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
