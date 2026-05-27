// Geometry channel decoder. Each SCTP message on `geometry_unframed` carries
// a single chunk laid out as:
//
//     [payloadSize: u64][GeometryPayloadType: u8]
//       [uid: u64 (omitted for RemoveNodes)][body...]
//
// `payloadSize` is the length of everything after the size field itself,
// emitted by both the C++ encoder (TeleportServer/GeometryEncoder.cpp
// `putPayloadSize`) and the node reference server (teleport-nodejs/protocol/
// encoders/{node,resource}_encoder.js `putPlaceholderSize`).
//
// We intentionally skip the size field instead of parsing it. The C++ client
// does the same (libavstream/.../webrtc_networksource.cpp `onMessage` —
// "//skip over the payload size, go straight to the payload type") and uses
// the SCTP message length as the source of truth. That covers a latent bug
// in the node reference server where the size value is written in big-endian
// (no `core.endian` argument on `setBigUint64`), which would otherwise fail
// validation against the protocol's stated little-endian convention.

import { BufferReader } from "../wire/reader.js";
import { GeometryPayloadType, type Uid } from "../wire/types.js";
import {
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
  type MaterialPayload,
  type MeshPayload,
  type NodeComponent,
  type NodePayload,
  type PositionKeyframe,
  type RemoveNodesPayload,
  type RotationKeyframe,
  type SkeletonPayload,
  type TextCanvasPayload,
  type TextureAccessor,
  type TexturePayload,
  type TexturePointerPayload,
  type MeshPointerPayload,
  type Transform,
} from "./payload.js";

/** Parse a single chunk from the geometry channel. */
export function parseGeometryChunk(packet: Uint8Array): GeometryPayload {
  if (packet.byteLength < 9) {
    throw new Error(
      `geometry chunk too short (${packet.byteLength} bytes; need >= 9)`,
    );
  }
  const r = new BufferReader(packet);
  r.skip(8); // skip the payloadSize field — see file header.
  const payloadType = r.u8() as GeometryPayloadType;

  if (payloadType === GeometryPayloadType.RemoveNodes) {
    return parseRemoveNodesBody(r);
  }

  // Every other chunk carries the resource uid in the header.
  const uid = r.uid();
  return dispatchBody(payloadType, uid, r);
}

/** Parse a payload body delivered out-of-band (e.g. an HTTP fetch resolving
 *  a TexturePointer/MeshPointer). The caller already knows the type and uid
 *  from the pointer chunk, so the body buffer contains only per-type bytes
 *  — no size/type/uid header. */
export function parseGeometryBody(
  payloadType: GeometryPayloadType,
  uid: Uid,
  body: Uint8Array,
): GeometryPayload {
  if (payloadType === GeometryPayloadType.RemoveNodes) {
    // RemoveNodes never arrives via HTTP and has no uid header.
    throw new Error("RemoveNodes cannot be decoded from an out-of-band body");
  }
  return dispatchBody(payloadType, uid, new BufferReader(body));
}

function dispatchBody(
  payloadType: GeometryPayloadType,
  uid: Uid,
  r: BufferReader,
): GeometryPayload {
  switch (payloadType) {
    case GeometryPayloadType.Node:
      return parseNodeBody(r, uid);
    case GeometryPayloadType.Mesh:
      return parseMeshBody(r, uid);
    case GeometryPayloadType.Material:
      return parseMaterialBody(r, uid);
    case GeometryPayloadType.Texture:
      return parseTextureBody(r, uid);
    case GeometryPayloadType.Animation:
      return parseAnimationBody(r, uid);
    case GeometryPayloadType.Skeleton:
      return parseSkeletonBody(r, uid);
    case GeometryPayloadType.FontAtlas:
      return parseFontAtlasBody(r, uid);
    case GeometryPayloadType.TextCanvas:
      return parseTextCanvasBody(r, uid);
    case GeometryPayloadType.TexturePointer:
      return parseTexturePointerBody(r, uid);
    case GeometryPayloadType.MeshPointer:
      return parseMeshPointerBody(r, uid);
    default:
      return {
        kind: "unknown",
        payloadType,
        uid,
        body: r.bytes(r.remaining),
      };
  }
}

function parseTransform(r: BufferReader): Transform {
  return {
    position: r.vec3(),
    rotation: r.vec4(),
    scale: r.vec3(),
  };
}

function parseNodeBody(r: BufferReader, uid: Uid): NodePayload {
  const name = r.string();
  const localTransform = parseTransform(r);
  const stationary = r.bool();
  const holderClientId = r.u64();
  const priority = r.i32();
  const parentId = r.uid();
  const numComponents = r.u8();
  let component: NodeComponent | null = null;
  if (numComponents > 0) {
    component = parseNodeComponent(r);
  }
  return {
    kind: GeometryPayloadType.Node,
    uid,
    name,
    localTransform,
    stationary,
    holderClientId,
    priority,
    parentId,
    component,
  };
}

function parseNodeComponent(r: BufferReader): NodeComponent {
  const dataType = r.u8() as NodeDataType;
  switch (dataType) {
    case NodeDataType.Mesh: {
      const meshUid = r.uid();
      const skeletonUid = r.uid();
      const jointIndices: number[] = [];
      const jointCount = r.u16();
      for (let i = 0; i < jointCount; i++) jointIndices.push(r.i16());
      const animations: bigint[] = [];
      const animCount = r.u16();
      for (let i = 0; i < animCount; i++) animations.push(r.uid());
      const materials: bigint[] = [];
      const matCount = r.u16();
      for (let i = 0; i < matCount; i++) materials.push(r.uid());
      const lightmapScaleOffset = r.vec4();
      const globalIlluminationUid = r.uid();
      return {
        kind: NodeDataType.Mesh,
        meshUid,
        skeletonUid,
        jointIndices,
        animations,
        materials,
        lightmapScaleOffset,
        globalIlluminationUid,
      };
    }
    case NodeDataType.Light: {
      const colour = r.vec4();
      const radius = r.f32();
      const range = r.f32();
      const direction = r.vec3();
      const lightType = r.u8();
      return { kind: NodeDataType.Light, colour, radius, range, direction, lightType };
    }
    case NodeDataType.TextCanvas:
      return { kind: NodeDataType.TextCanvas, textCanvasUid: r.uid() };
    case NodeDataType.Link: {
      const url = r.string();
      const query = r.string();
      return { kind: NodeDataType.Link, url, query };
    }
    default:
      throw new Error(`unsupported node component type: ${dataType}`);
  }
}

// Note: `parseMeshBody` and `parseTextureBody` only apply to *inline*
// chunks delivered on the geometry data channel, where the chunk header
// tags the bytes as Teleport-native. HTTP-fetched resources (referenced
// by TexturePointer / MeshPointer) are always standard codec files
// (KTX2 / PNG / JPEG / GLB / …) — those are dispatched by MIME in
// client.ts `fetchPointer` and never run through these parsers.
function parseMeshBody(r: BufferReader, uid: Uid): MeshPayload {
  const compression = r.u8() as MeshCompressionType;
  const version = r.u16();
  const dracoVersion = r.i32();
  const name = r.string();
  const invBindSize = Number(r.u64());
  const invBindData = invBindSize > 0 ? r.bytes(invBindSize) : new Uint8Array(0);
  const submeshCount = r.u32();
  const submeshes: MeshPayload["submeshes"] = [];
  for (let i = 0; i < submeshCount; i++) {
    const bufferSize = Number(r.u64());
    submeshes.push({ buffer: r.bytes(bufferSize) });
  }
  return {
    kind: GeometryPayloadType.Mesh,
    uid,
    compression,
    version,
    dracoVersion,
    name,
    invBindData,
    submeshes,
  };
}

function parseTextureAccessor(r: BufferReader): TextureAccessor {
  return {
    index: r.uid(),
    texCoord: r.u8(),
    tilingX: r.f32(),
    tilingY: r.f32(),
    scaleOrStrength: r.f32(),
  };
}

function parseMaterialBody(r: BufferReader, uid: Uid): MaterialPayload {
  const name = r.string();
  const materialMode = r.u8() as MaterialMode;
  const baseColorTexture = parseTextureAccessor(r);
  const baseColorFactor = r.vec4();
  const metallicRoughnessTexture = parseTextureAccessor(r);
  const metallicFactor = r.f32();
  const roughnessMultiplier = r.f32();
  const roughnessOffset = r.f32();
  const normalTexture = parseTextureAccessor(r);
  const occlusionTexture = parseTextureAccessor(r);
  const emissiveTexture = parseTextureAccessor(r);
  const emissiveFactor = r.vec3();
  const doubleSided = r.bool();
  const lightmapTexCoordIndex = r.u8();
  const extensionCount = Number(r.u64());
  const extensions: MaterialPayload["extensions"] = [];
  for (let i = 0; i < extensionCount; i++) {
    const id = r.u32();
    // Extension bodies are id-specific and undocumented for ids other than
    // SIMPLE_GRASS_WIND (0); preserve any trailing bytes for now.
    extensions.push({ id, body: new Uint8Array(0) });
  }
  const inlineTextureCount = r.u64();
  return {
    kind: GeometryPayloadType.Material,
    uid,
    name,
    materialMode,
    baseColorTexture,
    baseColorFactor,
    metallicRoughnessTexture,
    metallicFactor,
    roughnessMultiplier,
    roughnessOffset,
    normalTexture,
    occlusionTexture,
    emissiveTexture,
    emissiveFactor,
    doubleSided,
    lightmapTexCoordIndex,
    extensions,
    inlineTextureCount,
  };
}

function parseTextureBody(r: BufferReader, uid: Uid): TexturePayload {
  const name = r.string();
  const compression = r.u32() as TextureCompression;
  const data = r.bytes(r.remaining);
  return {
    kind: GeometryPayloadType.Texture,
    uid,
    name,
    compression,
    data,
  };
}

function parseAnimationBody(r: BufferReader, uid: Uid): AnimationPayload {
  const name = r.string();
  const duration = r.f32();
  const trackCount = Number(r.u64());
  const tracks: BoneTrack[] = [];
  for (let i = 0; i < trackCount; i++) {
    const boneIndex = r.i16();
    const positionKeyframes: PositionKeyframe[] = [];
    const posCount = r.u16();
    for (let j = 0; j < posCount; j++) {
      positionKeyframes.push({ time: r.f32(), value: r.vec3() });
    }
    const rotationKeyframes: RotationKeyframe[] = [];
    const rotCount = r.u16();
    for (let j = 0; j < rotCount; j++) {
      rotationKeyframes.push({ time: r.f32(), value: r.vec4() });
    }
    tracks.push({ boneIndex, positionKeyframes, rotationKeyframes });
  }
  return {
    kind: GeometryPayloadType.Animation,
    uid,
    name,
    duration,
    tracks,
  };
}

function parseSkeletonBody(r: BufferReader, uid: Uid): SkeletonPayload {
  const name = r.string();
  const boneCount = Number(r.u64());
  const boneIds: Uid[] = [];
  for (let i = 0; i < boneCount; i++) boneIds.push(r.uid());
  return {
    kind: GeometryPayloadType.Skeleton,
    uid,
    name,
    boneIds,
  };
}

function parseGlyph(r: BufferReader): Glyph {
  return {
    index: r.u16(),
    x0: r.u16(),
    y0: r.u16(),
    x1: r.u16(),
    y1: r.u16(),
    xOffset: r.f32(),
    yOffset: r.f32(),
    xAdvance: r.f32(),
    xOffset2: r.f32(),
    yOffset2: r.f32(),
  };
}

function parseFontAtlasBody(r: BufferReader, uid: Uid): FontAtlasPayload {
  const fontTextureUid = r.uid();
  const mapCount = r.u8();
  const maps: FontMap[] = [];
  for (let i = 0; i < mapCount; i++) {
    const pointSize = r.u16();
    const lineHeight = r.f32();
    const glyphCount = r.u16();
    const glyphs: Glyph[] = [];
    for (let g = 0; g < glyphCount; g++) glyphs.push(parseGlyph(r));
    maps.push({ pointSize, lineHeight, glyphs });
  }
  return {
    kind: GeometryPayloadType.FontAtlas,
    uid,
    fontTextureUid,
    maps,
  };
}

function parseTextCanvasBody(r: BufferReader, uid: Uid): TextCanvasPayload {
  const fontUid = r.uid();
  const pointSize = r.i32();
  const lineHeight = r.f32();
  const colour = r.vec4();
  const text = r.string();
  return {
    kind: GeometryPayloadType.TextCanvas,
    uid,
    fontUid,
    pointSize,
    lineHeight,
    colour,
    text,
  };
}

function parseTexturePointerBody(r: BufferReader, uid: Uid): TexturePointerPayload {
  return {
    kind: GeometryPayloadType.TexturePointer,
    uid,
    url: r.string(),
  };
}

function parseMeshPointerBody(r: BufferReader, uid: Uid): MeshPointerPayload {
  return {
    kind: GeometryPayloadType.MeshPointer,
    uid,
    url: r.string(),
  };
}

function parseRemoveNodesBody(r: BufferReader): RemoveNodesPayload {
  const count = r.u16();
  const uids: Uid[] = [];
  for (let i = 0; i < count; i++) uids.push(r.uid());
  return {
    kind: GeometryPayloadType.RemoveNodes,
    uids,
  };
}
