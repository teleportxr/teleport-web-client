// WebSocket signalling client.
//
// Wire protocol (text JSON envelopes, mirrors teleport-nodejs/signaling.js):
//
//   client -> server: {"teleport-signal-type":"connect","content":{"clientID":<u64>}}
//   server -> client: {"teleport-signal-type":"connect-response",
//                       "content":{"clientID":<u64>,"serverID":<u64>}}
//   server -> client: {"teleport-signal-type":"ice-servers","iceServers":[...]}
//   server -> client: {"teleport-signal-type":"offer","sdp":"..."}
//   client -> server: {"teleport-signal-type":"answer","sdp":"..."}
//   either:           {"teleport-signal-type":"candidate",
//                       "candidate":"...","mid":"...","mlineindex":<int>}
//   client -> server: {"teleport-signal-type":"disconnect"}
//
// "ice-servers" is sent once, before the offer, carrying the same STUN/TURN
// server list (standard RTCIceServer shape) the server itself uses — see
// docs/protocol/signaling.rst. This lets the server be the single source of
// truth for TURN credentials instead of hardcoding/duplicating them client-side.
//
// The `connect` envelope carries a free-form `capabilities` object so
// each side can advertise optional protocol features (e.g. avatar
// relay). Unknown keys MUST be ignored — see plans/avatars_plan.md.
//
// After the handshake completes the same WebSocket carries trickle-ICE
// candidates for the lifetime of the session.
//
// Binary fallback for the reliable channel:
//   The server may send reliable-channel commands (e.g. SetupCommand) before
//   the WebRTC reliable data channel has opened. In that case it transmits
//   the raw command bytes as a binary WebSocket frame on this socket and the
//   client must reply on the same socket until the WebRTC reliable channel
//   is open. See teleport-nodejs/client/client.js (signalingSend / receive-
//   ReliableBinaryMessage).

import {
  type SignalingCapabilities,
  encodeCapabilities,
} from "../protocol/avatars.js";

export type SignalingMessage =
  | {
      "teleport-signal-type": "connect";
      content: { clientID: string; capabilities: SignalingCapabilities };
    }
  | {
      "teleport-signal-type": "connect-response";
      content: { clientID: string | number; serverID: string | number };
    }
  | { "teleport-signal-type": "ice-servers"; iceServers: RTCIceServer[] }
  | { "teleport-signal-type": "offer"; sdp: string }
  | { "teleport-signal-type": "answer"; sdp: string }
  | {
      "teleport-signal-type": "candidate";
      candidate: string;
      mid: string;
      mlineindex: number;
    }
  | { "teleport-signal-type": "disconnect" };

export interface SignalingHandlers {
  onConnectResponse?: (clientId: bigint, serverId: bigint) => void;
  /** Server-supplied STUN/TURN server list, delivered once before the offer. */
  onIceServers?: (iceServers: RTCIceServer[]) => void;
  onOffer?: (sdp: string) => void;
  onCandidate?: (
    candidate: string,
    mid: string,
    mlineindex: number,
  ) => void;
  /** Raw reliable-channel payload delivered as a binary WebSocket frame. */
  onReliablePayload?: (data: ArrayBuffer) => void;
  /** Any signalling text frame whose `teleport-signal-type` is not one of
   *  the built-in types (connect-response / offer / candidate). The raw
   *  string is forwarded so downstream parsers (e.g. AvatarManager) can
   *  consume it without paying for double JSON parses. */
  onUnhandledSignal?: (raw: string) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (err: Event | Error) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: SignalingHandlers = {};
  /** Current client id (assigned by the server, or 0 to request a new one). */
  clientId: bigint = 0n;
  /** Server id (set on connect-response). */
  serverId: bigint = 0n;

  constructor(public readonly url: string) {}

  on(handlers: SignalingHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** Open the WebSocket and resolve once it is OPEN. Rejects on error/close. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws.binaryType = "arraybuffer";
      const onOpen = () => {
        this.ws?.removeEventListener("open", onOpen);
        this.ws?.removeEventListener("error", onErrorOnce);
        resolve();
      };
      const onErrorOnce = (ev: Event) => {
        this.ws?.removeEventListener("open", onOpen);
        this.ws?.removeEventListener("error", onErrorOnce);
        reject(ev);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onErrorOnce);
      this.ws.addEventListener("message", (ev) => this.handleMessage(ev));
      this.ws.addEventListener("close", (ev) => {
        this.handlers.onClose?.(ev);
      });
      this.ws.addEventListener("error", (ev) => {
        this.handlers.onError?.(ev);
      });
    });
  }

  /**
   * Session-level capabilities advertised on the next `connect`. Defaults
   * to all-true for the browser client — the web client can fetch peer
   * avatars directly (CORS permitting), so relay mode is on by default.
   * Host applications may override this before calling `sendConnect`.
   */
  capabilities: SignalingCapabilities = { avatar_relay: true };

  /** Send the initial connect request. clientId 0n requests a fresh id. */
  sendConnect(clientId: bigint = 0n): void {
    this.clientId = clientId;
    this.sendJson({
      "teleport-signal-type": "connect",
      content: {
        clientID: clientId.toString(),
        capabilities: encodeCapabilities(this.capabilities),
      },
    });
  }

  sendAnswer(sdp: string): void {
    // Match the server's exact escaping: it parses with JSON.parse after
    // replacing literal CR/LF with their escape sequences. JSON.stringify
    // already produces a valid string, so a vanilla send is sufficient.
    this.sendJson({ "teleport-signal-type": "answer", sdp });
  }

  sendCandidate(candidate: string, mid: string, mlineindex: number): void {
    this.sendJson({
      "teleport-signal-type": "candidate",
      candidate,
      mid,
      mlineindex,
    });
  }

  sendDisconnect(): void {
    this.sendJson({ "teleport-signal-type": "disconnect" });
  }

  /** Send a pre-serialised JSON text frame. Used by adjuncts such as
   *  AvatarManager that build their own envelopes and only need a
   *  transport hook. */
  sendRaw(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket is not open");
    }
    this.ws.send(text);
  }

  /** Send a reliable-channel payload over the signalling WebSocket as a
   *  binary frame. Used as a fallback before the WebRTC reliable channel
   *  opens. */
  sendBinary(payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket is not open");
    }
    // Send a fresh copy so the underlying buffer of a transient view
    // (e.g. one backed by a writer's growable ArrayBuffer) isn't aliased.
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    this.ws.send(copy);
  }

  /** True once the WebSocket is in the OPEN ready state. */
  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.sendDisconnect();
      } catch {
        // best-effort
      }
    }
    this.ws?.close();
    this.ws = null;
  }

  private sendJson(msg: SignalingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket is not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data !== "string") {
      // Binary frame: a reliable-channel payload pushed via the
      // server's signalingClient.receiveReliableBinaryMessage fallback.
      if (ev.data instanceof ArrayBuffer) {
        this.handlers.onReliablePayload?.(ev.data);
      } else if (ArrayBuffer.isView(ev.data)) {
        const v = ev.data as ArrayBufferView;
        // Copy out so the result is a plain ArrayBuffer regardless of whether
        // the view sits on a regular or shared buffer.
        const copy = new Uint8Array(v.byteLength);
        copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        this.handlers.onReliablePayload?.(copy.buffer);
      }
      return;
    }
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(ev.data) as SignalingMessage;
    } catch (err) {
      this.handlers.onError?.(err as Error);
      return;
    }
    switch (msg["teleport-signal-type"]) {
      case "connect-response": {
        this.clientId = BigInt(msg.content.clientID);
        this.serverId = BigInt(msg.content.serverID);
        this.handlers.onConnectResponse?.(this.clientId, this.serverId);
        break;
      }
      case "ice-servers":
        this.handlers.onIceServers?.(msg.iceServers);
        break;
      case "offer":
        this.handlers.onOffer?.(msg.sdp);
        break;
      case "candidate":
        this.handlers.onCandidate?.(msg.candidate, msg.mid, msg.mlineindex);
        break;
      default:
        // Anything else (avatar-*, application-defined, etc.) is forwarded
        // as the raw text so downstream parsers handle it without paying
        // for a second JSON.parse.
        this.handlers.onUnhandledSignal?.(ev.data);
        break;
    }
  }
}
