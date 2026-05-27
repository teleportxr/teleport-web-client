// HeadlessClient: thin wrapper around teleport-web-client's TeleportClient
// that records per-client metrics for the load harness. No rendering, no
// DOM. The wrapper never reaches into TeleportClient internals beyond the
// documented event-subscription surface and the public `peer`/`signaling`
// sub-objects.

import {
  TeleportClient,
  CommandPayloadType,
  GeometryPayloadType,
} from "../../../dist/teleport-web-client.js";
import { Histogram } from "./metrics.js";
import { NoOpFetcher } from "./no-op-fetcher.js";

// Reverse lookup tables so we can label counters by enum name.
const COMMAND_NAMES = buildEnumNameTable(CommandPayloadType);
const GEOMETRY_NAMES = buildEnumNameTable(GeometryPayloadType);

function buildEnumNameTable(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === "number") out[v] = k;
  }
  return out;
}

export class HeadlessClient {
  /**
   * @param {object} opts
   * @param {string}  opts.url        ws:// signalling URL
   * @param {string}  opts.assets     "fetch" | "off"     (default "fetch")
   * @param {number}  [opts.id]       caller-supplied id for logging
   */
  constructor(opts) {
    this.id = opts.id ?? 0;
    this.url = opts.url;
    this.assetsMode = opts.assets ?? "fetch";
    this.noopFetcher = this.assetsMode === "off" ? new NoOpFetcher() : null;

    const clientOpts = { url: opts.url, rtcConfig: { iceServers: [] } };
    if (this.noopFetcher) clientOpts.assets = this.noopFetcher;
    this.client = new TeleportClient(clientOpts);

    this.t0 = 0;
    this.stateTimings = {}; // state -> ms-since-t0
    this.stateChangeT0 = 0;
    this.state = "idle";

    this.commandsByType = {};   // name -> count
    this.payloadsByType = {};   // name -> count
    this.errors = 0;
    this.firstErrorMessage = null;
    this.bytesByChannel = {};   // channel key -> bytes

    this.handshakeHist = new Histogram(1024); // t signaling->streaming, ms
    this.pingIntervalHist = new Histogram(1024); // server ping cadence, ms
    this.lastPingT = 0;

    this._wire();
  }

  _wire() {
    this.client.onState((s) => {
      const tnow = performance.now();
      const sinceT0 = this.t0 ? tnow - this.t0 : 0;
      this.stateTimings[s] = sinceT0;
      this.state = s;
      this.stateChangeT0 = tnow;
      if (s === "streaming") this.handshakeHist.observe(sinceT0);
    });

    this.client.onCommand((cmd) => {
      const name = COMMAND_NAMES[cmd.kind] ?? `unknown(${cmd.kind})`;
      this.commandsByType[name] = (this.commandsByType[name] ?? 0) + 1;
      if (cmd.kind === CommandPayloadType.PingForLatency) {
        const tnow = performance.now();
        if (this.lastPingT) this.pingIntervalHist.observe(tnow - this.lastPingT);
        this.lastPingT = tnow;
      }
    });

    this.client.onPayload((p) => {
      const name = GEOMETRY_NAMES[p.kind] ?? `unknown(${p.kind})`;
      this.payloadsByType[name] = (this.payloadsByType[name] ?? 0) + 1;
    });

    this.client.onError((err) => {
      this.errors += 1;
      if (!this.firstErrorMessage)
        this.firstErrorMessage = err?.message ?? String(err);
    });

    // Byte counters for the six WebRTC data channels. We attach an extra
    // "message" listener per channel as the peer publishes it — additive,
    // not replacing TeleportClient's own dispatch. Bytes received on the
    // signalling-WS binary fallback path (before the WebRTC reliable
    // channel opens) are not counted yet and are negligible at steady
    // state; flagged in the README.
    this.client.peer.on({
      onChannel: (key, channel) => {
        channel.addEventListener("message", (ev) => {
          const data = ev.data;
          const n =
            data instanceof ArrayBuffer
              ? data.byteLength
              : ArrayBuffer.isView(data)
                ? data.byteLength
                : 0;
          this.bytesByChannel[key] = (this.bytesByChannel[key] ?? 0) + n;
        });
      },
    });
  }

  async connect() {
    this.t0 = performance.now();
    await this.client.connect();
  }

  close() {
    try {
      this.client.close();
    } catch {
      // best-effort
    }
  }

  /** Snapshot of per-client metrics. Safe to call at any time. */
  snapshot() {
    return {
      id: this.id,
      url: this.url,
      state: this.state,
      assets: this.assetsMode,
      state_timings_ms: { ...this.stateTimings },
      commands_by_type: { ...this.commandsByType },
      payloads_by_type: { ...this.payloadsByType },
      bytes_by_channel: { ...this.bytesByChannel },
      bytes_total:
        Object.values(this.bytesByChannel).reduce((a, b) => a + b, 0),
      errors: this.errors,
      first_error: this.firstErrorMessage,
      noop_fetcher_calls: this.noopFetcher?.calls ?? null,
      handshake_ms: this.handshakeHist.summary(),
      ping_interval_ms: this.pingIntervalHist.summary(),
    };
  }
}
