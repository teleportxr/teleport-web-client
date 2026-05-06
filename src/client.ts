// Top-level TeleportClient. Owns the signaling socket, the RTCPeerConnection,
// dispatch of incoming commands, and emission of typed lifecycle events.

import { SignalingClient } from "./transport/signaling.js";
import { TeleportPeerConnection, type ChannelKey } from "./transport/peer.js";
import { normalizeSignalingUrl } from "./url.js";
import {
  parseCommand,
  type ParsedCommand,
} from "./wire/commands.js";
import {
  buildAcknowledgement,
  buildHandshake,
  buildKeyframeRequest,
  buildOrthogonalAcknowledgement,
  buildPongForLatency,
  type HandshakeOptions,
} from "./wire/messages.js";
import { AxesStandard, CommandPayloadType } from "./wire/types.js";

/** Lifecycle phases reported via the `state` event. */
export type ClientState =
  | "idle"
  | "signaling"
  | "negotiating"
  | "handshake"
  | "streaming"
  | "closed"
  | "error";

export interface TeleportClientOptions {
  /** wss:// or ws:// URL of the Teleport signalling server. */
  url: string;
  /** Optional override of the WebRTC ICE server list. */
  rtcConfig?: RTCConfiguration;
  /** Handshake parameters. Sensible defaults are used for anything omitted. */
  handshake?: Partial<HandshakeOptions>;
}

type Listener<T> = (value: T) => void;

export class TeleportClient {
  readonly options: TeleportClientOptions;
  readonly signaling: SignalingClient;
  readonly peer: TeleportPeerConnection;
  state: ClientState = "idle";

  private stateListeners = new Set<Listener<ClientState>>();
  private commandListeners = new Set<Listener<ParsedCommand>>();
  private channelListeners = new Set<
    Listener<{ key: ChannelKey; data: ArrayBuffer }>
  >();
  private errorListeners = new Set<Listener<Error>>();
  private pingT0Ms = 0;

  constructor(opts: TeleportClientOptions) {
    this.options = opts;
    this.signaling = new SignalingClient(normalizeSignalingUrl(opts.url));
    this.peer = new TeleportPeerConnection(opts.rtcConfig);
    this.wire();
  }

  /** Open the signalling socket and begin the connection sequence. */
  async connect(): Promise<void> {
    this.setState("signaling");
    await this.signaling.open();
    this.signaling.sendConnect(0n);
  }

  /** Close everything. Safe to call multiple times. */
  close(): void {
    this.signaling.close();
    this.peer.close();
    this.setState("closed");
  }

  onState(listener: Listener<ClientState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onCommand(listener: Listener<ParsedCommand>): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  onChannelMessage(
    listener: Listener<{ key: ChannelKey; data: ArrayBuffer }>,
  ): () => void {
    this.channelListeners.add(listener);
    return () => this.channelListeners.delete(listener);
  }
  onError(listener: Listener<Error>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Send an arbitrary client message on the reliable channel. */
  sendReliable(payload: Uint8Array): void {
    this.peer.send("Reliable", payload);
  }

  /** Send an arbitrary client message on the unreliable channel. */
  sendUnreliable(payload: Uint8Array): void {
    this.peer.send("Unreliable", payload);
  }

  /** Request an IDR/keyframe from the server. */
  requestKeyframe(): void {
    this.sendUnreliable(buildKeyframeRequest());
  }

  private wire(): void {
    this.signaling.on({
      onConnectResponse: () => {
        this.setState("negotiating");
      },
      onOffer: async (sdp) => {
        try {
          const answer = await this.peer.acceptOffer(sdp);
          this.signaling.sendAnswer(answer);
        } catch (err) {
          this.fail(err as Error);
        }
      },
      onCandidate: (candidate, mid, mlineindex) => {
        this.peer
          .addRemoteCandidate(candidate, mid, mlineindex)
          .catch((err) => this.fail(err as Error));
      },
      onClose: () => {
        if (this.state !== "streaming") this.setState("closed");
      },
      onError: (err) => this.fail(err as Error),
    });

    this.peer.on({
      onIceCandidate: (candidate) => {
        this.signaling.sendCandidate(
          candidate.candidate,
          candidate.sdpMid ?? "",
          candidate.sdpMLineIndex ?? 0,
        );
      },
      onChannel: (key) => {
        if (key === "Reliable") this.sendInitialHandshake();
      },
      onMessage: (key, data) => {
        if (key === "Reliable") {
          const command = parseCommand(new Uint8Array(data));
          this.dispatchCommand(command);
        } else {
          this.channelListeners.forEach((l) => l({ key, data }));
        }
      },
    });
  }

  private sendInitialHandshake(): void {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    const w =
      typeof window !== "undefined" ? Math.floor(window.innerWidth * dpr) : 1280;
    const h =
      typeof window !== "undefined" ? Math.floor(window.innerHeight * dpr) : 720;
    const defaults: HandshakeOptions = {
      displayInfo: { width: w, height: h, framerate: 60 },
      axesStandard: AxesStandard.GlStyle,
      framerate: 60,
      isVR: false,
    };
    const opts: HandshakeOptions = {
      ...defaults,
      ...(this.options.handshake ?? {}),
      displayInfo: {
        ...defaults.displayInfo,
        ...(this.options.handshake?.displayInfo ?? {}),
      },
    };
    this.setState("handshake");
    this.sendReliable(buildHandshake(opts));
    this.pingT0Ms = performance.now();
  }

  private dispatchCommand(command: ParsedCommand): void {
    switch (command.kind) {
      case CommandPayloadType.AcknowledgeHandshake:
        this.setState("streaming");
        break;
      case CommandPayloadType.PingForLatency: {
        const latencyNs = BigInt(
          Math.max(0, Math.floor((performance.now() - this.pingT0Ms) * 1e6)),
        );
        this.sendReliable(buildPongForLatency(command.unixTimeNs, latencyNs));
        this.pingT0Ms = performance.now();
        break;
      }
      case CommandPayloadType.SetOriginNode:
      case CommandPayloadType.SetupLighting:
        this.sendReliable(buildAcknowledgement(command.ackId));
        break;
      case CommandPayloadType.Shutdown:
        this.close();
        break;
      default:
        break;
    }
    // Surface confirmation acks for NodeStateCommand subclasses elsewhere via
    // OrthogonalAcknowledgement once those payload types are parsed in detail.
    void buildOrthogonalAcknowledgement;
    this.commandListeners.forEach((l) => l(command));
  }

  private setState(next: ClientState): void {
    if (next === this.state) return;
    this.state = next;
    this.stateListeners.forEach((l) => l(next));
  }

  private fail(err: Error): void {
    this.setState("error");
    this.errorListeners.forEach((l) => l(err));
  }
}
