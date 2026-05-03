// Public entry point.

export {
  TeleportClient,
  type ClientState,
  type TeleportClientOptions,
} from "./client.js";

export { SignalingClient } from "./transport/signaling.js";
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
  parseCommand,
  type ParsedCommand,
  type SetupCommand,
  type AcknowledgeHandshakeCommand,
  type VideoConfig,
} from "./wire/commands.js";

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
