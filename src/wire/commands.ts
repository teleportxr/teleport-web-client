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

export interface SetupCommand {
  kind: CommandPayloadType.Setup;
  debugStream: number;
  debugNetworkPackets: number;
  requiredLatencyMs: number;
  idleConnectionTimeout: number;
  sessionId: bigint;
  videoConfig: VideoConfig;
  drawDistance: number;
  axesStandard: AxesStandard;
  audioInputEnabled: number;
  usingSsl: boolean;
  startTimestampUtcUnixUs: bigint;
  backgroundMode: BackgroundMode;
  backgroundColour: [number, number, number, number];
  backgroundTexture: Uid;
}

/** sizeof(SetupCommand) == 154 (including 1-byte tag). */
export function readSetupCommand(r: BufferReader): SetupCommand {
  return {
    kind: CommandPayloadType.Setup,
    debugStream: r.u32(),
    debugNetworkPackets: r.u32(),
    requiredLatencyMs: r.i32(),
    idleConnectionTimeout: r.u32(),
    sessionId: r.u64(),
    videoConfig: readVideoConfig(r),
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
  unixTimeNs: bigint;
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
      return { kind: CommandPayloadType.PingForLatency, unixTimeNs: r.i64() };
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
