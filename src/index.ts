// Public entry point.

export {
  TeleportClient,
  type ClientState,
  type TeleportClientOptions,
} from "./client.js";

export { SignalingClient } from "./transport/signaling.js";
export {
  AvatarManager,
  type AvatarPolicyCallback,
  type AvatarReplyFn,
  type AvatarResultCallback,
  type AvatarRevokeCallback,
  type AvatarSendFn,
} from "./avatar_manager.js";
export {
  AVATAR_SIGNAL_TYPES,
  decodeCapabilities,
  encodeCapabilities,
  encodeAvatarOffer,
  parseAvatarPolicy,
  parseAvatarResult,
  parseAvatarRevoke,
  type AvatarDeclared,
  type AvatarOffer,
  type AvatarPolicy,
  type AvatarProofOffer,
  type AvatarProofPolicy,
  type AvatarRequirements,
  type AvatarResult,
  type AvatarRevoke,
  type SignalingCapabilities,
} from "./protocol/avatars.js";
export { redactProof, redactUrl } from "./log/redact.js";
export {
  TeleportPeerConnection,
  type ChannelKey,
  type PeerHandlers,
} from "./transport/peer.js";

export {
  AxesStandard,
  BackgroundMode,
  ChannelId,
  ChannelLabel,
  ClientMessagePayloadType,
  CommandPayloadType,
  GeometryPayloadType,
  LightingMode,
  SignalingState,
  type Uid,
  VideoCodec,
  VideoPayloadType,
} from "./wire/types.js";

export { BufferReader } from "./wire/reader.js";
export { BufferWriter } from "./wire/writer.js";

export {
  parseGeometryBody,
  parseGeometryChunk,
} from "./geometry/decoder.js";
export {
  MaterialMode,
  MeshCompressionType,
  NodeDataType,
  TextureCompression,
  type AnimationPayload,
  type BoneTrack,
  type FontAtlasPayload,
  type FontMap,
  type GeometryPayload,
  type Glyph,
  type LightComponent,
  type LinkComponent,
  type MaterialExtension,
  type MaterialPayload,
  type MeshComponent,
  type MeshPayload,
  type MeshPointerPayload,
  type MeshSubmesh,
  type NodeComponent,
  type NodePayload,
  type PositionKeyframe,
  type RemoveNodesPayload,
  type RotationKeyframe,
  type SkeletonPayload,
  type TextCanvasComponentRef,
  type TextCanvasPayload,
  type TextureAccessor,
  type TexturePayload,
  type TexturePointerPayload,
  type Transform,
  type UnknownPayload,
  type Vec3,
  type Vec4,
} from "./geometry/payload.js";

export {
  AssetFetcher,
  type AssetFetcherOptions,
  type FetchedAsset,
} from "./http/assets.js";
export { ResourceCache, type PendingPointer } from "./scene/cache.js";
export { SceneAdapter, type SceneAdapterOptions } from "./scene/adapter.js";
export { AnimationController } from "./scene/animation.js";
export {
  DefaultMeshDecoder,
  DefaultTextureDecoder,
  isGltfBinary,
  isJpeg,
  isKtx2,
  isPng,
  resolveMeshFormat,
  resolveTextureFormat,
  type DecodedAnimation,
  type DecodedMesh,
  type MeshDecoder,
  type MeshFormatHint,
  type TextureDecoder,
  type TextureFormatHint,
} from "./scene/loaders.js";
export {
  ResourceResolver,
  SUPPORTED_TEXTURE_COMPRESSIONS,
  type ResourceResolverOptions,
} from "./scene/resources.js";

export {
  parseCommand,
  type ParsedCommand,
  type SetupCommand,
  type AcknowledgeHandshakeCommand,
  type AudioConfig,
  type VideoConfig,
} from "./wire/commands.js";

export { WebRTCAudio, type AudioOutputOptions } from "./audio/output.js";

export {
  buildHandshake,
  buildPongForLatency,
  buildAcknowledgement,
  buildOrthogonalAcknowledgement,
  buildKeyframeRequest,
  buildResourceLost,
  buildNodeStatus,
  buildReceivedResources,
  buildControllerPoses,
  buildInputStates,
  buildInputEvents,
  buildDisplayInfo,
  type HandshakeOptions,
  type DisplayInfo,
  type RenderingFeatures,
  type NodePose,
  type BinaryEvent,
  type AnalogueEvent,
  type MotionEvent,
} from "./wire/messages.js";

export { TeleportViewerElement } from "./component.js";

// Input layer (Phase 6): device readers, canonical paths, the swappable
// control models, and the abstract-input reporter.
export {
  DeviceHub,
  emptySnapshot,
  snapshotAxis,
  snapshotButton,
  type DeviceSnapshot,
  type InputDevice,
} from "./input/devices.js";
export { DesktopInput, type DesktopInputOptions } from "./input/desktop.js";
export { GamepadInput, type GamepadInputOptions } from "./input/gamepad.js";
export { InputReporter, type InputReport } from "./input/report.js";
export { compileBindings, type InputBinding } from "./input/bind.js";
export {
  FreeFlyModel,
  type FreeFlyOptions,
} from "./input/models/freefly.js";
export type {
  ControlModel,
  ControlOutput,
  Pose,
  PoseDynamic,
} from "./input/control_model.js";
export * as inputPaths from "./input/paths.js";
export {
  IDENTITY_QUAT,
  quatFromYawPitch,
  rotateVec,
  type Quat,
  type Vec3 as InputVec3,
} from "./input/math.js";

export {
  normalizeSignalingUrl,
  parseTeleportUrl,
  type ParsedTeleportUrl,
} from "./url.js";
