// Server -> client command parsers, one per CommandPayloadType.
// Each parser consumes the entire packet (including the 1-byte tag at offset 0)
// and returns a typed object.

import { BufferReader } from "./reader.js";
import {
  AxesStandard,
  BackgroundMode,
  CommandPayloadType,
  LightingMode,
  type Uid,
  VideoCodec,
} from "./types.js";

export interface VideoConfig {
  videoWidth: number;
  videoHeight: number;
  depthWidth: number;
  depthHeight: number;
  perspectiveWidth: number;
  perspectiveHeight: number;
  perspectiveFov: number;
  nearClipPlane: number;
  webcamWidth: number;
  webcamHeight: number;
  webcamOffsetX: number;
  webcamOffsetY: number;
  use10BitDecoding: boolean;
  useYuv444Decoding: boolean;
  useAlphaLayerDecoding: boolean;
  colourCubemapSize: number;
  composeCube: number;
  useCubemap: number;
  streamWebcam: number;
  videoCodec: VideoCodec;
  shadowmapX: number;
  shadowmapY: number;
  shadowmapSize: number;
}

/** sizeof(avs::VideoConfig) == 89. */
export function readVideoConfig(r: BufferReader): VideoConfig {
  return {
    videoWidth: r.u32(),
    videoHeight: r.u32(),
    depthWidth: r.u32(),
    depthHeight: r.u32(),
    perspectiveWidth: r.u32(),
    perspectiveHeight: r.u32(),
    perspectiveFov: r.f32(),
    nearClipPlane: r.f32(),
    webcamWidth: r.u32(),
    webcamHeight: r.u32(),
    webcamOffsetX: r.i32(),
    webcamOffsetY: r.i32(),
    use10BitDecoding: r.u32() !== 0,
    useYuv444Decoding: r.u32() !== 0,
    useAlphaLayerDecoding: r.u32() !== 0,
    colourCubemapSize: r.u32(),
    composeCube: r.i32(),
    useCubemap: r.i32(),
    streamWebcam: r.i32(),
    videoCodec: r.u8() as VideoCodec,
    shadowmapX: r.i32(),
    shadowmapY: r.i32(),
    shadowmapSize: r.i32(),
  };
}

/** sizeof(avs::AudioConfig) == 17. */
export interface AudioConfig {
  codec: number;            // 0=disabled, 1=Opus
  rtpPayloadType: number;   // dynamic payload type in SDP
  sampleRateHz: number;     // 48000 for Opus
  channelCount: number;
  frameDurationMs: number;  // 10|20|40|60
  flags: number;            // bit0=FEC, bit1=DTX, bit2=symmetric routing
  maxInboundStreams: number;
  selectionPolicy: number;  // 0=All, 1=Fifo, 2=Proximity, 3=ActiveSpeaker
  proximityRadiusMetres: number;
  evictionGraceMs: number;
}

/** sizeof(avs::AudioConfig) == 17. */
export function readAudioConfig(r: BufferReader): AudioConfig {
  return {
    codec: r.u8(),
    rtpPayloadType: r.u8(),
    sampleRateHz: r.u32(),
    channelCount: r.u8(),
    frameDurationMs: r.u8(),
    flags: r.u8(),
    maxInboundStreams: r.u8(),
    selectionPolicy: r.u8(),
    proximityRadiusMetres: r.f32(),
    evictionGraceMs: r.u16(),
  };
}

export interface SetupCommand {
  kind: CommandPayloadType.Setup;
  debugStream: number;
  debugNetworkPackets: number;
  requiredLatencyMs: number;
  idleConnectionTimeout: number;
  sessionId: bigint;
  videoConfig: VideoConfig;
  audioConfig: AudioConfig;
  drawDistance: number;
  axesStandard: AxesStandard;
  audioInputEnabled: number;
  usingSsl: boolean;
  startTimestampUtcUnixUs: bigint;
  backgroundMode: BackgroundMode;
  backgroundColour: [number, number, number, number];
  backgroundTexture: Uid;
}

/** sizeof(SetupCommand) == 171 (including 1-byte tag). */
export function readSetupCommand(r: BufferReader): SetupCommand {
  return {
    kind: CommandPayloadType.Setup,
    debugStream: r.u32(),
    debugNetworkPackets: r.u32(),
    requiredLatencyMs: r.i32(),
    idleConnectionTimeout: r.u32(),
    sessionId: r.u64(),
    videoConfig: readVideoConfig(r),
    audioConfig: readAudioConfig(r),
    drawDistance: r.f32(),
    axesStandard: r.u8() as AxesStandard,
    audioInputEnabled: r.u8(),
    usingSsl: r.bool(),
    startTimestampUtcUnixUs: r.i64(),
    backgroundMode: r.u8() as BackgroundMode,
    backgroundColour: r.vec4(),
    backgroundTexture: r.uid(),
  };
}

export interface AcknowledgeHandshakeCommand {
  kind: CommandPayloadType.AcknowledgeHandshake;
  visibleNodes: Uid[];
}

/** AcknowledgeHandshakeCommand: 1-byte tag + size_t count + count * uid. */
export function readAcknowledgeHandshakeCommand(
  r: BufferReader,
): AcknowledgeHandshakeCommand {
  // The C++ definition uses size_t, which is platform-dependent. On the
  // 64-bit reference servers this is 8 bytes; we treat it as u64.
  const count = Number(r.u64());
  const visibleNodes: Uid[] = [];
  for (let i = 0; i < count; i++) visibleNodes.push(r.uid());
  return { kind: CommandPayloadType.AcknowledgeHandshake, visibleNodes };
}

export interface ShutdownCommand {
  kind: CommandPayloadType.Shutdown;
}

export interface PingForLatencyCommand {
  kind: CommandPayloadType.PingForLatency;
  unixTimeUs: bigint;
}

export interface ReconfigureVideoCommand {
  kind: CommandPayloadType.ReconfigureVideo;
  videoConfig: VideoConfig;
}

export interface SetOriginNodeCommand {
  kind: CommandPayloadType.SetOriginNode;
  ackId: bigint;
  originNode: Uid;
  validCounter: bigint;
}

export interface SetupLightingCommand {
  kind: CommandPayloadType.SetupLighting;
  ackId: bigint;
  specularPos: [number, number];
  specularCubemapSize: number;
  specularMips: number;
  diffusePos: [number, number];
  diffuseCubemapSize: number;
  lightPos: [number, number];
  lightCubemapSize: number;
  specularTexture: Uid;
  diffuseTexture: Uid;
  lightingMode: LightingMode;
  giTextures: Uid[];
}

export interface SetupInputsCommand {
  kind: CommandPayloadType.SetupInputs;
  inputs: { inputId: number; inputType: number; regexPath: string }[];
}

export interface AssignNodePosePathCommand {
  kind: CommandPayloadType.AssignNodePosePath;
  nodeId: Uid;
  regexPath: string;
}

export interface NodeVisibilityCommand {
  kind: CommandPayloadType.NodeVisibility;
  showNodes: Uid[];
  hideNodes: Uid[];
}

/** One node's transform at a moment in server-session time. Mirrors
 *  `teleport::core::MovementUpdate`: packed, 85 bytes, little-endian. */
export interface MovementUpdate {
  /** Microseconds since `SetupCommand.startTimestampUtcUnixUs`. */
  serverTimeUs: bigint;
  /** False means the transform is local to the node's parent, which is what a node
   *  parented under this client's origin requires. Servers send parent-local. */
  isGlobal: boolean;
  nodeId: Uid;
  position: [number, number, number];
  /** Quaternion (x, y, z, w). */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** Metres per second, for extrapolation to predicted display time. Servers are
   *  expected to send zero; nothing here extrapolates. */
  velocity: [number, number, number];
  angularVelocityAxis: [number, number, number];
  /** Radians per second about `angularVelocityAxis`. */
  angularVelocityAngle: number;
}

/** Sent from server to move nodes it has already streamed. This is the only way a node
 *  moves after creation: the Node payload carries a transform once, at creation. */
export interface UpdateNodeMovementCommand {
  kind: CommandPayloadType.UpdateNodeMovement;
  updates: MovementUpdate[];
}

/** Sent from server to set what a node's skeleton should be playing.
 *
 *  Exactly 46 bytes on the wire. Sent on a change of state, not per frame, so a client
 *  that drops one stays in the previous animation until the next change.
 *
 *  `timestampUs` doubles as the blend control: dated slightly ahead of now, the client
 *  cross-fades to the new state over the intervening interval; dated "now", it snaps.
 *  `animTimeAtTimestamp` is where in the new clip to be at that instant, which is what
 *  carries the phase across a change of clip so the footfall does not jump. */
export interface ApplyAnimationCommand {
  kind: CommandPayloadType.ApplyNodeAnimation;
  /** Only layer 0 is implemented, by either reference client. */
  animLayer: number;
  /** Server-session time, microseconds since the setup command's datum — the same
   *  clock as `MovementUpdate.serverTimeUs`, never a wall-clock time. */
  timestampUs: bigint;
  nodeId: Uid;
  /** Which cache holds the clip; 0 means "the cache containing nodeId". */
  cacheId: Uid;
  animationId: Uid;
  /** Seconds into the clip at `timestampUs`. */
  animTimeAtTimestamp: number;
  /** Playback-rate multiplier from then on. Not a ground speed. */
  speedUnitsPerSecond: number;
  loop: boolean;
}

/** Sent from server when the set of audio tracks delivered to this client changes.
 *  The fixed header is followed by variable-length added/removed entries on the wire. */
export interface AudioSourceMappingCommand {
  kind: CommandPayloadType.AudioSourceMapping;
  addedCount: number;
  removedCount: number;
}

/** Sent from server to report user-visible audio state changes for participants. */
export interface AudioParticipantStateChangeCommand {
  kind: CommandPayloadType.AudioParticipantStateChange;
  updateCount: number;
}

export interface UnknownCommand {
  kind: "unknown";
  tag: CommandPayloadType;
  raw: Uint8Array;
}

export type ParsedCommand =
  | SetupCommand
  | AcknowledgeHandshakeCommand
  | ShutdownCommand
  | PingForLatencyCommand
  | ReconfigureVideoCommand
  | SetOriginNodeCommand
  | SetupLightingCommand
  | SetupInputsCommand
  | AssignNodePosePathCommand
  | NodeVisibilityCommand
  | UpdateNodeMovementCommand
  | ApplyAnimationCommand
  | AudioSourceMappingCommand
  | AudioParticipantStateChangeCommand
  | UnknownCommand;

/** Parse the full reliable-channel packet, dispatching on the leading tag byte. */
export function parseCommand(packet: Uint8Array): ParsedCommand {
  const r = new BufferReader(packet);
  const tag = r.u8() as CommandPayloadType;
  switch (tag) {
    case CommandPayloadType.Setup:
      return readSetupCommand(r);
    case CommandPayloadType.AcknowledgeHandshake:
      return readAcknowledgeHandshakeCommand(r);
    case CommandPayloadType.Shutdown:
      return { kind: CommandPayloadType.Shutdown };
    case CommandPayloadType.PingForLatency:
      return { kind: CommandPayloadType.PingForLatency, unixTimeUs: r.i64() };
    case CommandPayloadType.ReconfigureVideo:
      return {
        kind: CommandPayloadType.ReconfigureVideo,
        videoConfig: readVideoConfig(r),
      };
    case CommandPayloadType.SetOriginNode:
      return readSetOriginNodeCommand(r);
    case CommandPayloadType.SetupLighting:
      return readSetupLightingCommand(r);
    case CommandPayloadType.SetupInputs:
      return readSetupInputsCommand(r);
    case CommandPayloadType.AssignNodePosePath:
      return readAssignNodePosePathCommand(r);
    case CommandPayloadType.NodeVisibility:
      return readNodeVisibilityCommand(r);
    case CommandPayloadType.ApplyNodeAnimation:
      return readApplyAnimationCommand(r);
    case CommandPayloadType.UpdateNodeMovement:
      return readUpdateNodeMovementCommand(r);
    case CommandPayloadType.AudioSourceMapping:
      return { kind: CommandPayloadType.AudioSourceMapping, addedCount: r.u16(), removedCount: r.u16() };
    case CommandPayloadType.AudioParticipantStateChange:
      return { kind: CommandPayloadType.AudioParticipantStateChange, updateCount: r.u16() };
    default:
      return { kind: "unknown", tag, raw: packet.slice(1) };
  }
}

function readSetOriginNodeCommand(r: BufferReader): SetOriginNodeCommand {
  return {
    kind: CommandPayloadType.SetOriginNode,
    ackId: r.u64(),
    originNode: r.uid(),
    validCounter: r.u64(),
  };
}

function readSetupLightingCommand(r: BufferReader): SetupLightingCommand {
  const ackId = r.u64();
  const specularPos = r.int2();
  const specularCubemapSize = r.i32();
  const specularMips = r.i32();
  const diffusePos = r.int2();
  const diffuseCubemapSize = r.i32();
  const lightPos = r.int2();
  const lightCubemapSize = r.i32();
  const specularTexture = r.uid();
  const diffuseTexture = r.uid();
  const lightingMode = r.u8() as LightingMode;
  const giTextures: Uid[] = [];
  while (r.remaining >= 8) giTextures.push(r.uid());
  return {
    kind: CommandPayloadType.SetupLighting,
    ackId,
    specularPos,
    specularCubemapSize,
    specularMips,
    diffusePos,
    diffuseCubemapSize,
    lightPos,
    lightCubemapSize,
    specularTexture,
    diffuseTexture,
    lightingMode,
    giTextures,
  };
}

function readSetupInputsCommand(r: BufferReader): SetupInputsCommand {
  const numInputs = r.u16();
  const inputs: SetupInputsCommand["inputs"] = [];
  for (let i = 0; i < numInputs; i++) {
    const inputId = r.u16();
    const inputType = r.u8();
    const pathLength = r.u16();
    const regexPath = r.utf8(pathLength);
    inputs.push({ inputId, inputType, regexPath });
  }
  return { kind: CommandPayloadType.SetupInputs, inputs };
}

function readAssignNodePosePathCommand(
  r: BufferReader,
): AssignNodePosePathCommand {
  const nodeId = r.uid();
  const pathLength = r.u16();
  const regexPath = pathLength > 0 ? r.utf8(pathLength) : "";
  return { kind: CommandPayloadType.AssignNodePosePath, nodeId, regexPath };
}

/** Parse `UpdateNodeMovementCommand`: a `size_t` count followed by that many 85-byte
 *  MovementUpdate records. Field order on the wire is position, rotation, scale, velocity,
 *  angularVelocityAxis, angularVelocityAngle. */
export function readUpdateNodeMovementCommand(
  r: BufferReader,
): UpdateNodeMovementCommand {
  const count = Number(r.u64());
  const updates: MovementUpdate[] = [];
  for (let i = 0; i < count; i++) {
    updates.push({
      serverTimeUs: r.i64(),
      isGlobal: r.bool(),
      nodeId: r.uid(),
      position: r.vec3(),
      rotation: r.vec4(),
      scale: r.vec3(),
      velocity: r.vec3(),
      angularVelocityAxis: r.vec3(),
      angularVelocityAngle: r.f32(),
    });
  }
  return { kind: CommandPayloadType.UpdateNodeMovement, updates };
}

export function readApplyAnimationCommand(
  r: BufferReader,
): ApplyAnimationCommand {
  // Field order is fixed by the C++ struct's packed layout; see
  // docs/protocol/service/server_to_client.rst. timestampUs is signed: a client whose
  // clock datum runs ahead of the server's legitimately sees a negative value.
  return {
    kind: CommandPayloadType.ApplyNodeAnimation,
    animLayer: r.i32(),
    timestampUs: r.i64(),
    nodeId: r.uid(),
    cacheId: r.uid(),
    animationId: r.uid(),
    animTimeAtTimestamp: r.f32(),
    speedUnitsPerSecond: r.f32(),
    loop: r.bool(),
  };
}

function readNodeVisibilityCommand(r: BufferReader): NodeVisibilityCommand {
  const showCount = Number(r.u64());
  const hideCount = Number(r.u64());
  const showNodes: Uid[] = [];
  const hideNodes: Uid[] = [];
  for (let i = 0; i < showCount; i++) showNodes.push(r.uid());
  for (let i = 0; i < hideCount; i++) hideNodes.push(r.uid());
  return {
    kind: CommandPayloadType.NodeVisibility,
    showNodes,
    hideNodes,
  };
}
