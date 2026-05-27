// Single-client smoke test driven through HeadlessClient. Connects to a
// teleport server, waits until the session reaches `streaming`, holds for a
// few seconds, then closes and prints the per-client metrics snapshot.
//
// Usage:
//   node src/smoke.js [ws://host:port] [hold_seconds] [assets]
// Defaults:
//   url          = ws://localhost:8081
//   hold_seconds = 5
//   assets       = fetch    (fetch | off)

import "./node-shims.js";
import { HeadlessClient } from "./headless-client.js";

const url = process.argv[2] ?? "ws://localhost:8081";
const holdSeconds = Number(process.argv[3] ?? 5);
const assets = process.argv[4] ?? "fetch";

const hc = new HeadlessClient({ id: 1, url, assets });
const t0 = performance.now();
const stamp = () =>
  `[+${((performance.now() - t0) / 1000).toFixed(3)}s]`;

hc.client.onState((s) => console.log(`${stamp()} state -> ${s}`));
hc.client.onError((err) =>
  console.error(`${stamp()} error: ${err?.message ?? err}`),
);

let closed = false;
function shutdown(reason) {
  if (closed) return;
  closed = true;
  console.log(`${stamp()} shutdown (${reason})`);
  hc.close();
  console.log(JSON.stringify(hc.snapshot(), null, 2));
  // Give the WS / RTC stacks a moment to flush before exiting.
  setTimeout(() => process.exit(hc.errors > 0 ? 1 : 0), 250);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

(async () => {
  console.log(`${stamp()} connecting to ${url} (assets=${assets})`);
  try {
    await hc.connect();
  } catch (err) {
    console.error(`${stamp()} connect() rejected:`, err);
    shutdown("connect-failed");
    return;
  }
  const deadline = performance.now() + 30_000;
  while (
    hc.state !== "streaming" &&
    hc.state !== "closed" &&
    hc.state !== "error" &&
    performance.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (hc.state === "streaming") {
    console.log(`${stamp()} streaming - holding for ${holdSeconds}s`);
    await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    shutdown("hold-elapsed");
  } else {
    shutdown(`never-streaming (state=${hc.state})`);
  }
})();
