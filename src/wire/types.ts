// Wire-format enums and constants. Mirrors the C++ headers in
// Teleport/TeleportCore/export_include/TeleportCore/CommonNetworking.h
// and Teleport/libavstream/export_include/libavstream/common_exports.h
// All structs are 1-byte packed and little-endian on the wire.

/** Server -> client message tag (CommandPayloadType, uint8). */
export enum CommandPayloadType {
  Invalid = 0,
  Shutdown = 1,
  Setup = 2,
  AcknowledgeHandshake = 3,
  ReconfigureVideo = 4,
  NodeVisibility = 5,
  UpdateNodeMovement = 6,
  UpdateNodeEnabledState = 7,
  SetNodeHighlighted = 8,
  ApplyNodeAnimation = 9,
  UpdateNodeAnimationControlX = 10,
  SetNodeAnimationSpeed = 11,
  SetupLighting = 12,
  UpdateNodeStructure = 13,
  AssignNodePosePath = 14,
  SetupInputs = 15,
  PingForLatency = 16,
  AudioSourceMapping = 17,
  AudioParticipantStateChange = 18,
  SetOriginNode = 128,
}

/** Client -> server message tag (ClientMessagePayloadType, uint8). */
export enum ClientMessagePayloadType {
  Invalid = 0,
  Handshake = 1,
  NodeStatus = 2,
  ReceivedResources = 3,
  ControllerPoses = 4,
  ResourceLost = 5,
  InputStates = 6,
  InputEvents = 7,
  DisplayInfo = 8,
  KeyframeRequest = 9,
  PongForLatency = 10,
  OrthogonalAcknowledgement = 11,
  Acknowledgement = 12,
}

/** avs::VideoCodec (uint8). */
export enum VideoCodec {
  Any = 0,
  H264 = 1,
  HEVC = 2,
}

/** avs::AxesStandard (uint8). Bit-field of handedness + vertical axis. */
export enum AxesStandard {
  NotInitialized = 0,
  RightHanded = 1,
  LeftHanded = 2,
  YVertical = 4,
  ZVertical = 8,
  EngineeringStyle = 8 | 1, // ZVertical | RightHanded = 9
  GlStyle = 16 | 4 | 1, // 21
  UnrealStyle = 32 | 8 | 2, // 42
  UnityStyle = 64 | 4 | 2, // 70
}

/** avs::GeometryPayloadType (uint8). */
export enum GeometryPayloadType {
  Invalid = 0,
  Mesh = 1,
  Material = 2,
  MaterialInstance = 3,
  Texture = 4,
  Animation = 5,
  Node = 6,
  Skeleton = 7,
  FontAtlas = 8,
  TextCanvas = 9,
  TexturePointer = 10,
  MeshPointer = 11,
  MaterialPointer = 12,
  RemoveNodes = 13,
}

/** avs::VideoPayloadType (uint8) — first byte of video-channel chunks. */
export enum VideoPayloadType {
  FirstVCL = 0,
  VCL = 1,
  VPS = 2,
  SPS = 3,
  PPS = 4,
  ALE = 5,
  OtherNALUnit = 6,
  AccessUnit = 7,
}

/** teleport::core::BackgroundMode (uint8). */
export enum BackgroundMode {
  None = 0,
  Colour = 1,
  Texture = 2,
  Video = 3,
}

/** teleport::core::LightingMode (uint8). */
export enum LightingMode {
  None = 0,
  Texture = 1,
  Video = 2,
}

/** teleport::core::SignalingState (host-side enum, mirrored locally). */
export enum SignalingState {
  Start = "Start",
  Requested = "Requested",
  Accepted = "Accepted",
  Streaming = "Streaming",
  Invalid = "Invalid",
}

/** Pre-negotiated WebRTC data-channel ids (server side creates these).
 *  Note: audio is now carried as a WebRTC media track (Opus/RTP), not a data channel. */
export const ChannelId = {
  Video: 20,
  VideoTags: 40,
  Geometry: 80,
  Reliable: 100,
  Unreliable: 120,
} as const;

export type ChannelIdValue = (typeof ChannelId)[keyof typeof ChannelId];

/** Channel labels (must match server). */
export const ChannelLabel = {
  Video: "video",
  VideoTags: "video_tags",
  Geometry: "geometry_unframed",
  Reliable: "reliable",
  Unreliable: "unreliable",
} as const;

/** A 64-bit unsigned id used throughout the protocol (avs::uid). */
export type Uid = bigint;
