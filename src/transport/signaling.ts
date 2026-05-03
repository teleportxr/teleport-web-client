// WebSocket signalling client.
//
// Wire protocol (text JSON envelopes, mirrors teleport-nodejs/signaling.js):
//
//   client -> server: {"teleport-signal-type":"connect","content":{"clientID":<u64>}}
//   server -> client: {"teleport-signal-type":"connect-response",
//                       "content":{"clientID":<u64>,"serverID":<u64>}}
//   server -> client: {"teleport-signal-type":"offer","sdp":"..."}
//   client -> server: {"teleport-signal-type":"answer","sdp":"..."}
//   either:           {"teleport-signal-type":"candidate",
//                       "candidate":"...","mid":"...","mlineindex":<int>}
//   client -> server: {"teleport-signal-type":"disconnect"}
//
// After the handshake completes the same WebSocket carries trickle-ICE
// candidates for the lifetime of the session.

export type SignalingMessage =
  | { "teleport-signal-type": "connect"; content: { clientID: string } }
  | {
      "teleport-signal-type": "connect-response";
      content: { clientID: string | number; serverID: string | number };
    }
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
  onOffer?: (sdp: string) => void;
  onCandidate?: (
    candidate: string,
    mid: string,
    mlineindex: number,
  ) => void;
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

  /** Send the initial connect request. clientId 0n requests a fresh id. */
  sendConnect(clientId: bigint = 0n): void {
    this.clientId = clientId;
    this.sendJson({
      "teleport-signal-type": "connect",
      content: { clientID: clientId.toString() },
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
      // Server can also push binary on this channel via
      // signalingClient.receiveReliableBinaryMessage; future use.
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
      case "offer":
        this.handlers.onOffer?.(msg.sdp);
        break;
      case "candidate":
        this.handlers.onCandidate?.(msg.candidate, msg.mid, msg.mlineindex);
        break;
    }
  }
}
