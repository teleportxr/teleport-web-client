// Top-level TeleportClient. Owns the signaling socket, the RTCPeerConnection,
// dispatch of incoming commands, and emission of typed lifecycle events.

import { SignalingClient } from "./transport/signaling.js";
import { TeleportPeerConnection, type ChannelKey } from "./transport/peer.js";
import { AvatarManager } from "./avatar_manager.js";
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
  buildReceivedResources,
  buildResourceLost,
  type HandshakeOptions,
} from "./wire/messages.js";
import {
  AxesStandard,
  CommandPayloadType,
  GeometryPayloadType,
  type Uid,
} from "./wire/types.js";
import { parseGeometryChunk } from "./geometry/decoder.js";
import {
  MeshCompressionType,
  TextureCompression,
  type GeometryPayload,
  type MeshPayload,
  type TexturePayload,
} from "./geometry/payload.js";
import { ResourceCache } from "./scene/cache.js";
import { resolveMeshFormat, resolveTextureFormat } from "./scene/loaders.js";
import type { DecodedAnimation } from "./scene/loaders.js";
import { AssetFetcher } from "./http/assets.js";
import { WebRTCAudio } from "./audio/output.js";

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
  /** Override of the HTTP fetcher used for TexturePointer / MeshPointer URLs. */
  assets?: AssetFetcher;
  /** Decoder for animation clips named by AnimationPointer. Without one, clips are
   *  acknowledged (so the server stops resending) but never played.
   *
   *  Typically `DefaultMeshDecoder.decodeAnimation`, bound. Kept an option rather than
   *  a hard dependency so this class stays transport-only and free of a runtime
   *  three.js import. */
  animationDecoder?: (bytes: Uint8Array) => Promise<DecodedAnimation>;
}

type Listener<T> = (value: T) => void;

export class TeleportClient {
  readonly options: TeleportClientOptions;
  readonly signaling: SignalingClient;
  readonly peer: TeleportPeerConnection;
  readonly cache: ResourceCache;
  readonly assets: AssetFetcher;
  /** Avatar-negotiation state for this server. Host applications set
   *  their PolicyCallback via avatars.setOnAvatarPolicy(). */
  readonly avatars: AvatarManager;
  state: ClientState = "idle";

  private audio: WebRTCAudio | null = null;

  private stateListeners = new Set<Listener<ClientState>>();
  private commandListeners = new Set<Listener<ParsedCommand>>();
  private payloadListeners = new Set<Listener<GeometryPayload>>();
  private channelListeners = new Set<
    Listener<{ key: ChannelKey; data: ArrayBuffer }>
  >();
  private errorListeners = new Set<Listener<Error>>();
  private animationListeners = new Set<
    (uid: Uid, decoded: DecodedAnimation) => void
  >();
  private pingT0Ms = 0;
  /** `SetupCommand.startTimestampUtcUnixUs`: the datum this session's clock counts from.
   *  Zero until the setup command arrives. */
  private sessionDatumUnixUs = 0n;
  private receivedBatch: Uid[] = [];
  private receivedFlushHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TeleportClientOptions) {
    this.options = opts;
    this.signaling = new SignalingClient(normalizeSignalingUrl(opts.url));
    this.peer = new TeleportPeerConnection(opts.rtcConfig);
    this.cache = new ResourceCache();
    this.assets = opts.assets ?? new AssetFetcher();
    // Avatar signalling routes outbound frames through the same socket
    // the SignalingClient owns; binding `this.signaling` deferred via a
    // closure keeps the manager send-only and lets the socket lifecycle
    // be managed entirely by SignalingClient.
    this.avatars = new AvatarManager((raw) => this.signaling.sendRaw(raw));
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
    if (this.receivedFlushHandle) {
      clearTimeout(this.receivedFlushHandle);
      this.receivedFlushHandle = null;
    }
    this.signaling.close();
    this.peer.close();
    this.audio?.close();
    this.audio = null;
    this.assets.clear();
    this.cache.clear();
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
  onPayload(listener: Listener<GeometryPayload>): () => void {
    this.payloadListeners.add(listener);
    return () => this.payloadListeners.delete(listener);
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
  /** This session's clock: microseconds since the setup command's datum.
   *
   *  This is the clock every server timestamp is expressed in. Anything comparing
   *  against `ApplyAnimation.timestampUs` or `MovementUpdate.serverTimeUs` must use it
   *  rather than a wall-clock time — mixing the two puts the value ~1.8e15 µs out, far
   *  enough that a 32-bit float has no fractional precision left at all.
   *
   *  Returns 0 before the setup command has arrived. */
  sessionTimeUs(): bigint {
    if (this.sessionDatumUnixUs === 0n) return 0n;
    return BigInt(Math.floor(Date.now() * 1000)) - this.sessionDatumUnixUs;
  }

  /** An animation clip named by an AnimationPointer has been fetched and decoded.
   *  Fires before the resource is acknowledged, so a listener that registers the clip
   *  synchronously is ready by the time the server considers it delivered. */
  onAnimationClip(
    listener: (uid: Uid, decoded: DecodedAnimation) => void,
  ): () => void {
    this.animationListeners.add(listener);
    return () => this.animationListeners.delete(listener);
  }

  /** Send an arbitrary client message on the reliable channel. Falls back
   *  to a binary frame on the signalling WebSocket if the WebRTC reliable
   *  data channel is not yet open — the server treats both as equivalent
   *  reliable-channel transports. */
  sendReliable(payload: Uint8Array): void {
    const reliable = this.peer.channels["Reliable"];
    if (reliable && reliable.readyState === "open") {
      this.peer.send("Reliable", payload);
      return;
    }
    if (this.signaling.isOpen) {
      this.signaling.sendBinary(payload);
      return;
    }
    throw new Error("no reliable transport available (WebRTC + signaling both down)");
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
      onIceServers: (iceServers) => {
        this.peer.setIceServers(iceServers);
      },
      onOffer: async (sdp) => {
        console.log("[client] onOffer, sdp has m=audio:", sdp.includes("m=audio"));
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
      onReliablePayload: (data) => {
        // Server-side fallback: reliable-channel commands delivered over the
        // signalling WebSocket as a binary frame (used before the WebRTC
        // reliable data channel opens). Decode through the same path.
        try {
          const command = parseCommand(new Uint8Array(data));
          this.dispatchCommand(command);
        } catch (err) {
          this.errorListeners.forEach((l) => l(err as Error));
        }
      },
      onUnhandledSignal: (raw) => {
        // Avatar-negotiation frames travel on the signalling channel as
        // JSON text. The AvatarManager consumes avatar-* messages and
        // ignores anything else.
        this.avatars.handleSignalingMessage(raw);
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
      onMessage: (key, data) => {
        if (key === "Reliable") {
          const command = parseCommand(new Uint8Array(data));
          this.dispatchCommand(command);
        } else if (key === "Geometry") {
          this.handleGeometryChunk(new Uint8Array(data));
        } else {
          this.channelListeners.forEach((l) => l({ key, data }));
        }
      },
      onTrack: (track, _streams, transceiver) => {
        // Server-forwarded remote audio (e.g. mic from another participant).
        // The track's SDP `mid` is the decimal uid of the emitting scene node
        // (see audio.rst); it is spatialised at that node's transform.
        console.log("[client] onTrack", track.kind, "audio manager ready:", !!this.audio, "mid=", transceiver?.mid);
        if (track.kind === "audio" && this.audio) {
          const nodeUid = parseNodeUid(transceiver?.mid);
          this.audio.attachIncomingTrack(track, nodeUid);
        }
      },
    });
  }

  private handleGeometryChunk(packet: Uint8Array): void {
    let payload: GeometryPayload;
    try {
      payload = parseGeometryChunk(packet);
    } catch (err) {
      // Surface as a non-fatal error so a single malformed chunk doesn't
      // tear down the session; the server can retransmit on the next pass.
      this.errorListeners.forEach((l) => l(err as Error));
      return;
    }
    this.cache.put(payload);
    this.payloadListeners.forEach((l) => l(payload));

    // A remote audio track is spatialised at its emitting node's transform
    // (track mid = node uid). Update the panner position from the node payload.
    // NOTE: uses the node's local transform; full world-transform tracking off
    // the scene graph is a follow-up (see audio.rst).
    if (payload.kind === GeometryPayloadType.Node && this.audio) {
      const [px, py, pz] = payload.localTransform.position;
      this.audio.setEmitterPosition(payload.uid.toString(), px, py, pz);
    }

    if (payload.kind === GeometryPayloadType.TexturePointer) {
      this.fetchPointer(payload.uid, payload.url, GeometryPayloadType.Texture, payload.axesStandard);
      return;
    }
    if (payload.kind === GeometryPayloadType.MeshPointer) {
      this.fetchPointer(payload.uid, payload.url, GeometryPayloadType.Mesh, payload.axesStandard);
      return;
    }
    if (payload.kind === GeometryPayloadType.AnimationPointer) {
      this.fetchAnimation(payload.uid, payload.url);
      return;
    }
    if (payload.kind === GeometryPayloadType.RemoveNodes ||
        payload.kind === "unknown") {
      return;
    }
    // Resource chunks (Mesh/Material/Texture/Node/…) — confirm receipt.
    this.queueReceived(payload.uid);
  }

  private fetchPointer(
    uid: Uid,
    url: string,
    targetType: GeometryPayloadType.Texture | GeometryPayloadType.Mesh,
    axesStandard: AxesStandard,
  ): void {
    // HTTP-fetched resources are never in a teleport-native struct format —
    // they're always standard files (KTX2 / PNG / JPEG / GLB / Draco). We
    // dispatch by HTTP Content-Type, falling back to URL extension and then
    // magic bytes when the server returns an uninformative MIME. The
    // codec-specific decoder (DefaultTextureDecoder / DefaultMeshDecoder)
    // runs later, when the resolver resolves the cached payload.
    this.assets.get(url)
      .then((asset) => {
        let payload: GeometryPayload | null = null;
        if (targetType === GeometryPayloadType.Texture) {
          const hint = resolveTextureFormat(asset.mime, asset.url, asset.bytes);
          if (hint) {
            payload = synthTexturePayload(uid, url, hint.compression, asset.bytes, axesStandard);
          }
        } else {
          const hint = resolveMeshFormat(asset.mime, asset.url, asset.bytes);
          if (hint?.kind === "mesh-gltf-binary") {
            payload = synthGltfMeshPayload(uid, url, asset.bytes);
          }
          // mesh-gltf-json and mesh-draco aren't decoded yet; the current
          // server only emits .glb mesh pointers. Falling through to the
          // null branch surfaces a clear error + ResourceLost.
        }
        if (!payload) {
          const err = new Error(
            `unrecognised resource format (uid=${uid}, mime=${asset.mime}, url=${url})`,
          );
          this.errorListeners.forEach((l) => l(err));
          this.sendReliable(buildResourceLost([uid]));
          return;
        }
        this.cache.put(payload);
        this.payloadListeners.forEach((l) => l(payload));
        this.queueReceived(uid);
      })
      .catch((err) => {
        this.errorListeners.forEach((l) => l(err as Error));
        this.sendReliable(buildResourceLost([uid]));
      });
  }

  /** Fetch and decode an animation clip named by an AnimationPointer.
   *
   *  Acknowledged only once the clip is decoded and registered, not when the bytes
   *  land: the server takes the acknowledgement as "ready to be played", and naming a
   *  clip the client cannot yet use means the state is dropped with nothing to retry it. */
  private fetchAnimation(uid: Uid, url: string): void {
    const decoder = this.options.animationDecoder;
    if (!decoder) {
      // No decoder configured: acknowledge so the server stops resending, and let
      // any state naming this clip simply not play.
      this.queueReceived(uid);
      return;
    }
    this.assets.get(url)
      .then((asset) => decoder(asset.bytes))
      .then((decoded) => {
        if (!decoded.clips.length) throw new Error(`no clips in ${url}`);
        this.animationListeners.forEach((l) => l(uid, decoded));
        this.queueReceived(uid);
      })
      .catch((err) => {
        this.errorListeners.forEach((l) => l(err as Error));
        this.sendReliable(buildResourceLost([uid]));
      });
  }

  private queueReceived(uid: Uid): void {
    this.receivedBatch.push(uid);
    if (this.receivedFlushHandle) return;
    // Coalesce acks into one message per tick to avoid one send per chunk
    // when the server bursts an initial scene.
    this.receivedFlushHandle = setTimeout(() => this.flushReceived(), 16);
  }

  private flushReceived(): void {
    this.receivedFlushHandle = null;
    if (!this.receivedBatch.length) return;
    const uids = this.receivedBatch;
    this.receivedBatch = [];
    try {
      this.sendReliable(buildReceivedResources(uids));
    } catch (err) {
      // Channel may have closed between enqueue and flush; treat as terminal.
      this.errorListeners.forEach((l) => l(err as Error));
    }
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
      case CommandPayloadType.Setup: {
        // The datum for this session's clock. Every timestamp the server sends —
        // ApplyAnimation.timestampUs, MovementUpdate.serverTimeUs — is measured from
        // here, so it has to be captured before any of them can be interpreted.
        this.sessionDatumUnixUs = command.startTimestampUtcUnixUs;
        // Server has sent its SetupCommand — reply with the Handshake on
        // whichever reliable transport is available. Guard against duplicate
        // sends if SetupCommand is re-delivered on a re-handshake.
        if (this.state !== "handshake" && this.state !== "streaming") {
          this.sendInitialHandshake();
        }
        // Initialise the audio module when the server has media-track audio enabled.
        if (command.audioConfig.codec !== 0 && !this.audio) {
          this.audio = new WebRTCAudio({ sampleRate: command.audioConfig.sampleRateHz });
        }
        // If the server wants mic input, request capture and add the track to
        // the peer connection. replaceTrack() works without renegotiation on an
        // already-negotiated sendonly/sendrecv transceiver.
        if (command.audioConfig.codec !== 0 && command.audioInputEnabled !== 0) {
          this.audio!.requestMicTrack().then((track) => {
            this.peer.addTrack(track);
          }).catch((err: Error) => {
            this.errorListeners.forEach((l) => l(err));
          });
        }
        break;
      }
      case CommandPayloadType.AcknowledgeHandshake:
        this.setState("streaming");
        break;
      case CommandPayloadType.PingForLatency: {
        const latencyUs = BigInt(
          Math.max(0, Math.floor((performance.now() - this.pingT0Ms) * 1e3)),
        );
        this.sendReliable(buildPongForLatency(command.unixTimeUs, latencyUs));
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

/** Build a `MeshPayload` whose single submesh holds the raw bytes of a
 *  fetched glTF binary, so the resolver / MeshDecoder can decode it through
 *  the same code path as Draco meshes. The protocol Mesh-struct fields are
 *  filler — the MeshDecoder reads only `submeshes[i].buffer`. */
function synthGltfMeshPayload(
  uid: Uid,
  url: string,
  body: Uint8Array,
): MeshPayload {
  return {
    kind: GeometryPayloadType.Mesh,
    uid,
    compression: MeshCompressionType.None,
    version: 0,
    dracoVersion: 0,
    name: url,
    invBindData: new Uint8Array(0),
    submeshes: [{ buffer: body }],
    // Where it came from: a glTF's own image uris are relative to it, so the decoder
    // cannot resolve them without this.
    sourceUrl: url,
  };
}

/** Build a `TexturePayload` directly from raw codec bytes fetched over HTTP.
 *  Bypasses `parseTextureBody` (which only applies to inline geometry-
 *  channel chunks); the body here is the codec file itself. */
function synthTexturePayload(
  uid: Uid,
  url: string,
  compression: TextureCompression,
  body: Uint8Array,
  axesStandard: AxesStandard,
): TexturePayload {
  return {
    kind: GeometryPayloadType.Texture,
    uid,
    name: url,
    compression,
    data: body,
    axesStandard,
    // The url is the identity of this texture resource; a glTF image uri resolving to it
    // names this texture rather than one of its own.
    sourceUrl: url,
  };
}

/** Parse a transceiver `mid` into the emitting node's uid (decimal string). The
 *  server sets the track `mid` to the source node uid (see audio.rst); returns
 *  the string unchanged when it is a non-negative integer, else undefined
 *  (non-spatial). Kept as a string to avoid losing precision on 64-bit uids. */
function parseNodeUid(mid: string | null | undefined): string | undefined {
  if (mid == null) return undefined;
  if (!/^[0-9]+$/.test(mid)) return undefined;
  return mid;
}
