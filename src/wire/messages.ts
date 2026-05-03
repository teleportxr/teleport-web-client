// Client -> server message builders, one per ClientMessagePayloadType.
// Each builder returns a Uint8Array ready to be sent on the reliable or
// unreliable WebRTC channel as appropriate.

import { BufferWriter } from "./writer.js";
import {
  AxesStandard,
  ClientMessagePayloadType,
  type Uid,
} from "./types.js";

/** Common ClientMessage header: 1-byte tag + 8-byte timestamp_unix_ms. */
function startMessage(
  w: BufferWriter,
  kind: ClientMessagePayloadType,
  timestampUnixMs: bigint = BigInt(Date.now()),
): void {
  w.u8(kind).i64(timestampUnixMs);
}

export interface DisplayInfo {
  width: number;
  height: number;
  framerate: number;
}

export interface RenderingFeatures {
  normals: boolean;
  ambientOcclusion: boolean;
}

export interface HandshakeOptions {
  displayInfo: DisplayInfo;
  metresPerUnit?: number;
  fov?: number;
  udpBufferSizeKb?: number;
  maxBandwidthKbps?: number;
  axesStandard: AxesStandard;
  framerate: number;
  isVR: boolean;
  maxLightsSupported?: number;
  minimumPriority?: number;
  renderingFeatures?: RenderingFeatures;
  /** uids of resources the client already has cached. */
  resourceUids?: Uid[];
}

/** Build the initial Handshake (sizeof base struct == 58 + 8*resourceCount). */
export function buildHandshake(opts: HandshakeOptions): Uint8Array {
  const w = new BufferWriter(96);
  startMessage(w, ClientMessagePayloadType.Handshake);
  // avs::DisplayInfo: u32 width, u32 height, f32 framerate
  w.u32(opts.displayInfo.width)
    .u32(opts.displayInfo.height)
    .f32(opts.displayInfo.framerate);
  w.f32(opts.metresPerUnit ?? 1.0);
  w.f32(opts.fov ?? 90.0);
  w.u32(opts.udpBufferSizeKb ?? 0);
  w.u32(opts.maxBandwidthKbps ?? 0);
  w.u8(opts.axesStandard);
  w.u8(opts.framerate);
  w.bool(opts.isVR);
  const resources = opts.resourceUids ?? [];
  w.u64(BigInt(resources.length));
  w.u32(opts.maxLightsSupported ?? 0);
  w.i32(opts.minimumPriority ?? 0);
  // RenderingFeatures: 2 bools.
  w.bool(opts.renderingFeatures?.normals ?? false);
  w.bool(opts.renderingFeatures?.ambientOcclusion ?? false);
  for (const uid of resources) w.uid(uid);
  return w.toUint8Array();
}

/** Pong response to a PingForLatencyCommand. */
export function buildPongForLatency(
  unixTimeNs: bigint,
  serverToClientLatencyNs: bigint,
): Uint8Array {
  const w = new BufferWriter(32);
  startMessage(w, ClientMessagePayloadType.PongForLatency);
  w.i64(unixTimeNs).i64(serverToClientLatencyNs);
  return w.toUint8Array();
}

/** Acknowledge an AckedCommand by ack_id. */
export function buildAcknowledgement(ackId: bigint): Uint8Array {
  const w = new BufferWriter(24);
  startMessage(w, ClientMessagePayloadType.Acknowledgement);
  w.u64(ackId);
  return w.toUint8Array();
}

/** OrthogonalAcknowledgement (NodeStateCommand confirmation). */
export function buildOrthogonalAcknowledgement(
  confirmationNumber: bigint,
): Uint8Array {
  const w = new BufferWriter(24);
  startMessage(w, ClientMessagePayloadType.OrthogonalAcknowledgement);
  w.u64(confirmationNumber);
  return w.toUint8Array();
}

/** KeyframeRequest (header only). */
export function buildKeyframeRequest(): Uint8Array {
  const w = new BufferWriter(16);
  startMessage(w, ClientMessagePayloadType.KeyframeRequest);
  return w.toUint8Array();
}

/** ResourceLost: 1-byte tag + 8-byte timestamp + u16 count + count * uid. */
export function buildResourceLost(uids: Uid[]): Uint8Array {
  const w = new BufferWriter(16 + 8 * uids.length);
  startMessage(w, ClientMessagePayloadType.ResourceLost);
  w.u16(uids.length);
  for (const uid of uids) w.uid(uid);
  return w.toUint8Array();
}

/** NodeStatus: tag + ts + size_t drawn + size_t wantToRelease + uids. */
export function buildNodeStatus(
  drawn: Uid[],
  wantToRelease: Uid[],
): Uint8Array {
  const w = new BufferWriter(32 + 8 * (drawn.length + wantToRelease.length));
  startMessage(w, ClientMessagePayloadType.NodeStatus);
  w.u64(BigInt(drawn.length)).u64(BigInt(wantToRelease.length));
  for (const uid of drawn) w.uid(uid);
  for (const uid of wantToRelease) w.uid(uid);
  return w.toUint8Array();
}

/** ReceivedResources: tag + ts + size_t count + uids. */
export function buildReceivedResources(uids: Uid[]): Uint8Array {
  const w = new BufferWriter(24 + 8 * uids.length);
  startMessage(w, ClientMessagePayloadType.ReceivedResources);
  w.u64(BigInt(uids.length));
  for (const uid of uids) w.uid(uid);
  return w.toUint8Array();
}

export interface NodePose {
  uid: Uid;
  position: [number, number, number];
  orientation: [number, number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
}

/** ControllerPoses: tag + ts + headPose(28) + u16 numPoses + numPoses * NodePose. */
export function buildControllerPoses(
  headPose: { position: [number, number, number]; orientation: [number, number, number, number] },
  nodePoses: NodePose[],
): Uint8Array {
  const w = new BufferWriter(64 + 64 * nodePoses.length);
  startMessage(w, ClientMessagePayloadType.ControllerPoses);
  // Pose_packed: orientation(vec4) + position(vec3) — 28 bytes
  w.vec4(...headPose.orientation).vec3(...headPose.position);
  w.u16(nodePoses.length);
  for (const np of nodePoses) {
    w.uid(np.uid);
    // PoseDynamic_packed: pose(28) + velocity(12) + angularVelocity(12)
    w.vec4(...np.orientation).vec3(...np.position);
    w.vec3(...np.velocity);
    w.vec3(...np.angularVelocity);
  }
  return w.toUint8Array();
}

/** InputStates: tag + ts + InputState header + binary bitfield + analogue array. */
export function buildInputStates(
  binaryStates: boolean[],
  analogueStates: number[],
): Uint8Array {
  const numBinary = binaryStates.length;
  const numAnalogue = analogueStates.length;
  const binaryBytes = Math.ceil(numBinary / 8);
  const w = new BufferWriter(16 + 4 + binaryBytes + 4 * numAnalogue);
  startMessage(w, ClientMessagePayloadType.InputStates);
  // InputState: u16 numBinary, u16 numAnalogue
  w.u16(numBinary).u16(numAnalogue);
  // Pack binary states into a bitfield (LSB-first within each byte).
  const bits = new Uint8Array(binaryBytes);
  for (let i = 0; i < numBinary; i++) {
    if (binaryStates[i]) bits[i >> 3] |= 1 << (i & 7);
  }
  w.raw(bits);
  for (const v of analogueStates) w.f32(v);
  return w.toUint8Array();
}

export interface BinaryEvent {
  eventId: number;
  inputId: number;
  activated: boolean;
}
export interface AnalogueEvent {
  eventId: number;
  inputId: number;
  strength: number;
}
export interface MotionEvent {
  eventId: number;
  inputId: number;
  motion: [number, number];
}

/** InputEvents: tag + ts + 3 u16 counts + binary[] + analogue[] + motion[]. */
export function buildInputEvents(
  binary: BinaryEvent[],
  analogue: AnalogueEvent[],
  motion: MotionEvent[],
): Uint8Array {
  const w = new BufferWriter(
    16 + 6 + 7 * binary.length + 10 * analogue.length + 14 * motion.length,
  );
  startMessage(w, ClientMessagePayloadType.InputEvents);
  w.u16(binary.length).u16(analogue.length).u16(motion.length);
  for (const e of binary) w.u32(e.eventId).u16(e.inputId).bool(e.activated);
  for (const e of analogue) w.u32(e.eventId).u16(e.inputId).f32(e.strength);
  for (const e of motion)
    w.u32(e.eventId).u16(e.inputId).f32(e.motion[0]).f32(e.motion[1]);
  return w.toUint8Array();
}

/** DisplayInfoMessage. */
export function buildDisplayInfo(info: DisplayInfo): Uint8Array {
  const w = new BufferWriter(24);
  startMessage(w, ClientMessagePayloadType.DisplayInfo);
  w.u32(info.width).u32(info.height).f32(info.framerate);
  return w.toUint8Array();
}
