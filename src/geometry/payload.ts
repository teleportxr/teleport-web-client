// Decoded shapes for every GeometryPayloadType on the geometry channel.
// Mirrors Teleport/docs/protocol/geometry_payload.rst.

import { GeometryPayloadType, type Uid } from "../wire/types.js";

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Vec4;
  scale: Vec3;
}

export enum MeshCompressionType {
  None = 0,
  Draco = 1,
}

export enum TextureCompression {
  Uncompressed = 0,
  Png = 1,
  MultiplePng = 2,
  Ktx = 3,
  Jpeg = 4,
}

export enum MaterialMode {
  Unknown = 0,
  Opaque = 1,
  Transparent = 2,
  Masked = 3,
}

export enum NodeDataType {
  Invalid = 0,
  None = 1,
  Mesh = 2,
  Light = 3,
  TextCanvas = 4,
  Unused1 = 5,
  SkeletonUnused = 6,
  Link = 7,
  Script = 8,
  AudioEmitter = 9,
}

/** Bit 0 of AudioEmitter.flags. */
export const AUDIO_EMITTER_SPATIALISED = 1 << 0;

/** Why an emitter with audioStreamIndex === 0 is silent (for UI). */
export enum AudioSilenceReason {
  None = 0,
  OutOfRange = 1,
  CapExceeded = 2,
  Muted = 3,
}

export interface MeshComponent {
  kind: NodeDataType.Mesh;
  meshUid: Uid;
  skeletonUid: Uid;
  jointIndices: number[];
  animations: Uid[];
  materials: Uid[];
  lightmapScaleOffset: Vec4;
  globalIlluminationUid: Uid;
}

export interface LightComponent {
  kind: NodeDataType.Light;
  colour: Vec4;
  radius: number;
  range: number;
  direction: Vec3;
  lightType: number;
}

export interface TextCanvasComponentRef {
  kind: NodeDataType.TextCanvas;
  textCanvasUid: Uid;
}

export interface LinkComponent {
  kind: NodeDataType.Link;
  url: string;
  query: string;
}

export interface AudioEmitterComponentRef {
  kind: NodeDataType.AudioEmitter;
  /** Abstract stream index carried on the track `mid`; 0 = present but silent. */
  audioStreamIndex: number;
  flags: number;
  /** Derived from `flags` bit 0. */
  spatialised: boolean;
  silenceReason: AudioSilenceReason;
  gain: number;
  minDistanceMetres: number;
  maxDistanceMetres: number;
}

export type NodeComponent =
  | MeshComponent
  | LightComponent
  | TextCanvasComponentRef
  | LinkComponent
  | AudioEmitterComponentRef;

export interface NodePayload {
  kind: GeometryPayloadType.Node;
  uid: Uid;
  name: string;
  localTransform: Transform;
  stationary: boolean;
  holderClientId: bigint;
  priority: number;
  parentId: Uid;
  /** First non-audio data component (mesh/light/…), or null. */
  component: NodeComponent | null;
  /** Audio emitter component, when the node carries one. */
  audioEmitter: AudioEmitterComponentRef | null;
}

export interface MeshSubmesh {
  buffer: Uint8Array;
}

export interface MeshPayload {
  kind: GeometryPayloadType.Mesh;
  uid: Uid;
  compression: MeshCompressionType;
  version: number;
  dracoVersion: number;
  name: string;
  /** Tightly packed mat4s, one per joint. */
  invBindData: Uint8Array;
  submeshes: MeshSubmesh[];
}

export interface TextureAccessor {
  index: Uid;
  texCoord: number;
  tilingX: number;
  tilingY: number;
  /** Union: normal-map `scale` or occlusion `strength`. */
  scaleOrStrength: number;
}

export interface MaterialExtension {
  id: number;
  body: Uint8Array;
}

export interface MaterialPayload {
  kind: GeometryPayloadType.Material;
  uid: Uid;
  name: string;
  materialMode: MaterialMode;
  baseColorTexture: TextureAccessor;
  baseColorFactor: Vec4;
  metallicRoughnessTexture: TextureAccessor;
  metallicFactor: number;
  roughnessMultiplier: number;
  roughnessOffset: number;
  normalTexture: TextureAccessor;
  occlusionTexture: TextureAccessor;
  emissiveTexture: TextureAccessor;
  emissiveFactor: Vec3;
  doubleSided: boolean;
  lightmapTexCoordIndex: number;
  extensions: MaterialExtension[];
  /** Always 0 in the current protocol; reserved for inline texture bundles. */
  inlineTextureCount: bigint;
}

export interface TexturePayload {
  kind: GeometryPayloadType.Texture;
  uid: Uid;
  name: string;
  compression: TextureCompression;
  /** Codec-specific payload (PNG / JPEG / KTX2 / packed PNG array). */
  data: Uint8Array;
}

export interface PositionKeyframe {
  time: number;
  value: Vec3;
}

export interface RotationKeyframe {
  time: number;
  value: Vec4;
}

export interface BoneTrack {
  boneIndex: number;
  positionKeyframes: PositionKeyframe[];
  rotationKeyframes: RotationKeyframe[];
}

export interface AnimationPayload {
  kind: GeometryPayloadType.Animation;
  uid: Uid;
  name: string;
  duration: number;
  tracks: BoneTrack[];
}

export interface SkeletonPayload {
  kind: GeometryPayloadType.Skeleton;
  uid: Uid;
  name: string;
  boneIds: Uid[];
}

export interface Glyph {
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  xOffset: number;
  yOffset: number;
  xAdvance: number;
  xOffset2: number;
  yOffset2: number;
}

export interface FontMap {
  pointSize: number;
  lineHeight: number;
  glyphs: Glyph[];
}

export interface FontAtlasPayload {
  kind: GeometryPayloadType.FontAtlas;
  uid: Uid;
  fontTextureUid: Uid;
  maps: FontMap[];
}

export interface TextCanvasPayload {
  kind: GeometryPayloadType.TextCanvas;
  uid: Uid;
  fontUid: Uid;
  pointSize: number;
  lineHeight: number;
  colour: Vec4;
  text: string;
}

export interface TexturePointerPayload {
  kind: GeometryPayloadType.TexturePointer;
  uid: Uid;
  url: string;
}

export interface MeshPointerPayload {
  kind: GeometryPayloadType.MeshPointer;
  uid: Uid;
  url: string;
}

export interface RemoveNodesPayload {
  kind: GeometryPayloadType.RemoveNodes;
  uids: Uid[];
}

export interface UnknownPayload {
  kind: "unknown";
  payloadType: GeometryPayloadType;
  uid: Uid;
  body: Uint8Array;
}

export type GeometryPayload =
  | NodePayload
  | MeshPayload
  | MaterialPayload
  | TexturePayload
  | AnimationPayload
  | SkeletonPayload
  | FontAtlasPayload
  | TextCanvasPayload
  | TexturePointerPayload
  | MeshPointerPayload
  | RemoveNodesPayload
  | UnknownPayload;
