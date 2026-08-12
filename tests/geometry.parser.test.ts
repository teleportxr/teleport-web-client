// Round-trip tests for the geometry-channel chunk parsers.
// Each fixture is hand-built byte-for-byte to match the wire format described
// in Teleport/docs/protocol/geometry_payload.rst, then fed through
// parseGeometryChunk(). Where the spec and the node reference server disagree
// (e.g. integer-width choices for counts), tests follow the spec.

import { describe, expect, it } from "vitest";
import { BufferWriter } from "../src/wire/writer.js";
import { AxesStandard, GeometryPayloadType } from "../src/wire/types.js";
import { parseGeometryBody, parseGeometryChunk } from "../src/geometry/decoder.js";
import {
  MaterialMode,
  MeshCompressionType,
  NodeDataType,
  TextureCompression,
} from "../src/geometry/payload.js";

function writeString(w: BufferWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.u16(bytes.byteLength).raw(bytes);
}

/** Wrap a chunk body in the 8-byte payloadSize prefix that every geometry-
 *  channel SCTP message starts with (see geometry_payload.rst). */
function chunk(build: (w: BufferWriter) => void): Uint8Array {
  const body = new BufferWriter();
  build(body);
  const bodyBytes = body.toUint8Array();
  const out = new BufferWriter(8 + bodyBytes.byteLength);
  out.u64(BigInt(bodyBytes.byteLength)).raw(bodyBytes);
  return out.toUint8Array();
}

describe("parseGeometryChunk — RemoveNodes", () => {
  it("decodes a count + uid list with no header uid", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.RemoveNodes);
      w.u16(2);
      w.u64(0x11n).u64(0x22n);
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.RemoveNodes);
    if (payload.kind === GeometryPayloadType.RemoveNodes) {
      expect(payload.uids).toEqual([0x11n, 0x22n]);
    }
  });

  it("rejects a chunk too short to even hold the size + type header", () => {
    expect(() => parseGeometryChunk(new Uint8Array(8))).toThrow(/too short/);
  });

  it("tolerates a wrong (big-endian) payloadSize header from the node server", () => {
    // The node reference server emits this field big-endian by mistake; the
    // C++ client (and ours) ignores the value and uses the SCTP message
    // length instead. Synthesise a chunk whose size header is garbage.
    const body = new BufferWriter();
    body.u8(GeometryPayloadType.RemoveNodes).u16(1).u64(0x42n);
    const bodyBytes = body.toUint8Array();
    const w = new BufferWriter(8 + bodyBytes.byteLength);
    w.u64(0xdeadbeefdeadbeefn).raw(bodyBytes); // deliberately wrong size
    const payload = parseGeometryChunk(w.toUint8Array());
    if (payload.kind === GeometryPayloadType.RemoveNodes) {
      expect(payload.uids).toEqual([0x42n]);
    } else {
      throw new Error("expected RemoveNodes");
    }
  });
});

describe("parseGeometryChunk — TexturePointer / MeshPointer", () => {
  it("decodes a TexturePointer URL", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.TexturePointer).u64(78n);
      w.u8(AxesStandard.NotInitialized); // placeholder byte, leads every pointer body
      writeString(w, "/a/b.ktx2");
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.TexturePointer);
    if (payload.kind === GeometryPayloadType.TexturePointer) {
      expect(payload.uid).toBe(78n);
      expect(payload.axesStandard).toBe(AxesStandard.NotInitialized);
      expect(payload.url).toBe("/a/b.ktx2");
    }
  });

  it("decodes a MeshPointer URL", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.MeshPointer).u64(42n);
      w.u8(AxesStandard.NotInitialized);
      writeString(w, "https://cdn.example/m.draco");
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.MeshPointer);
    if (payload.kind === GeometryPayloadType.MeshPointer) {
      expect(payload.url).toBe("https://cdn.example/m.draco");
    }
  });

  it("reads the axes standard leading a MeshPointer body", () => {
    // glTF is always Y-up right-handed, whatever the server's scene uses, so an asset like
    // this has to say so or the client imports it tipped on its side.
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.MeshPointer).u64(42n);
      w.u8(AxesStandard.GlStyle);
      writeString(w, "/generic_avatar.vrm");
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.MeshPointer);
    if (payload.kind === GeometryPayloadType.MeshPointer) {
      expect(payload.url).toBe("/generic_avatar.vrm");
      expect(payload.axesStandard).toBe(AxesStandard.GlStyle);
    }
  });

  it("decodes an AnimationPointer URL", () => {
    // Same body layout as MeshPointer. A .vrma is glTF, so it declares GlStyle whatever
    // frame the scene around it uses.
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.AnimationPointer).u64(24n);
      w.u8(AxesStandard.GlStyle);
      writeString(w, "/avatar_anim/Walking.vrma");
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.AnimationPointer);
    if (payload.kind === GeometryPayloadType.AnimationPointer) {
      expect(payload.uid).toBe(24n);
      expect(payload.url).toBe("/avatar_anim/Walking.vrma");
      expect(payload.axesStandard).toBe(AxesStandard.GlStyle);
    }
  });

  it("treats a MeshPointer with NotInitialized axes as the server's own", () => {
    // An asset authored in the server's own frame declares nothing, so the byte is zero.
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.MeshPointer).u64(42n);
      w.u8(AxesStandard.NotInitialized);
      writeString(w, "/legacy.glb");
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.MeshPointer);
    if (payload.kind === GeometryPayloadType.MeshPointer) {
      expect(payload.axesStandard).toBe(AxesStandard.NotInitialized);
    }
  });
});

describe("parseGeometryChunk — Node", () => {
  it("decodes a parentless mesh-bearing node", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Node).u64(1000n);
      writeString(w, "root");
      // Transform: position(12) + rotation(16) + scale(12)
      w.vec3(1, 2, 3).vec4(0, 0, 0, 1).vec3(1, 1, 1);
      w.bool(true); // stationary
      w.u64(0n); // holder_client_id
      w.i32(7); // priority
      w.u64(0n); // parent
      w.u8(1); // numComponents
      // Mesh component
      w.u8(NodeDataType.Mesh);
      w.u64(500n); // mesh uid
      w.u64(0n); // skeleton uid
      w.u16(0); // joint_indices count
      w.u16(1).u64(801n); // 1 animation
      w.u16(2).u64(601n).u64(602n); // 2 materials
      w.vec4(1, 1, 0, 0); // lightmapScaleOffset
      w.u64(0n); // gi uid
    });

    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.Node);
    if (payload.kind === GeometryPayloadType.Node) {
      expect(payload.uid).toBe(1000n);
      expect(payload.name).toBe("root");
      expect(payload.localTransform.position).toEqual([1, 2, 3]);
      expect(payload.priority).toBe(7);
      expect(payload.component?.kind).toBe(NodeDataType.Mesh);
      if (payload.component?.kind === NodeDataType.Mesh) {
        expect(payload.component.meshUid).toBe(500n);
        expect(payload.component.animations).toEqual([801n]);
        expect(payload.component.materials).toEqual([601n, 602n]);
      }
    }
  });

  it("decodes a node with no component (numComponents = 0)", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Node).u64(7n);
      writeString(w, "");
      w.vec3(0, 0, 0).vec4(0, 0, 0, 1).vec3(1, 1, 1);
      w.bool(false).u64(0n).i32(0).u64(5n).u8(0);
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.Node);
    if (payload.kind === GeometryPayloadType.Node) {
      expect(payload.parentId).toBe(5n);
      expect(payload.component).toBeNull();
    }
  });

  it("decodes a light component", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Node).u64(2n);
      writeString(w, "lamp");
      w.vec3(0, 1, 0).vec4(0, 0, 0, 1).vec3(1, 1, 1);
      w.bool(true).u64(0n).i32(0).u64(0n).u8(1);
      w.u8(NodeDataType.Light);
      w.vec4(1, 0.9, 0.8, 1.5); // colour + intensity
      w.f32(0.1).f32(20); // radius, range
      w.vec3(0, -1, 0);
      w.u8(2); // point light
    });
    const payload = parseGeometryChunk(packet);
    if (payload.kind === GeometryPayloadType.Node && payload.component?.kind === NodeDataType.Light) {
      expect(payload.component.range).toBe(20);
      expect(payload.component.lightType).toBe(2);
    }
  });
});

describe("parseGeometryChunk — Material", () => {
  it("decodes a minimal opaque material with no extensions", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Material).u64(601n);
      writeString(w, "mat");
      w.u8(MaterialMode.Opaque);
      // baseColorTexture (25 bytes)
      w.u64(0n).u8(0).f32(1).f32(1).f32(1);
      w.vec4(1, 1, 1, 1);
      // metallicRoughnessTexture
      w.u64(0n).u8(0).f32(1).f32(1).f32(0);
      w.f32(0).f32(1).f32(0);
      // normal
      w.u64(0n).u8(0).f32(1).f32(1).f32(1);
      // occlusion
      w.u64(0n).u8(0).f32(1).f32(1).f32(1);
      // emissive
      w.u64(0n).u8(0).f32(1).f32(1).f32(0);
      w.vec3(0, 0, 0);
      w.bool(false).u8(0);
      w.u64(0n); // extensionCount
      w.u64(0n); // inlineTextureCount
    });

    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.Material);
    if (payload.kind === GeometryPayloadType.Material) {
      expect(payload.uid).toBe(601n);
      expect(payload.materialMode).toBe(MaterialMode.Opaque);
      expect(payload.baseColorFactor).toEqual([1, 1, 1, 1]);
      expect(payload.extensions).toHaveLength(0);
    }
  });
});

describe("parseGeometryChunk — Texture", () => {
  it("captures the codec payload tail as raw bytes", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Texture).u64(78n);
      writeString(w, "envCloudyCubemap.ktx2");
      w.u32(TextureCompression.Ktx);
      w.raw(new Uint8Array([0xAB, 0xCD, 0xEF]));
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.Texture);
    if (payload.kind === GeometryPayloadType.Texture) {
      expect(payload.compression).toBe(TextureCompression.Ktx);
      expect(Array.from(payload.data)).toEqual([0xAB, 0xCD, 0xEF]);
    }
  });
});

describe("parseGeometryChunk — Mesh", () => {
  it("decodes a single-submesh Draco mesh", () => {
    const dracoBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Mesh).u64(500n);
      w.u8(MeshCompressionType.Draco);
      w.u16(1).i32(1);
      writeString(w, "cube");
      w.u64(0n); // invBindDataSize
      w.u32(1); // submeshCount
      w.u64(BigInt(dracoBytes.byteLength)).raw(dracoBytes);
    });
    const payload = parseGeometryChunk(packet);
    expect(payload.kind).toBe(GeometryPayloadType.Mesh);
    if (payload.kind === GeometryPayloadType.Mesh) {
      expect(payload.compression).toBe(MeshCompressionType.Draco);
      expect(payload.submeshes).toHaveLength(1);
      expect(Array.from(payload.submeshes[0].buffer)).toEqual([1, 2, 3, 4, 5]);
    }
  });
});

describe("parseGeometryBody (out-of-band HTTP decode)", () => {
  it("decodes a Texture body the same way as an inline Texture chunk", () => {
    // Build the same fixture as the inline Texture test, but without the
    // size+type+uid header — that's what an HTTP fetch returns.
    const body = new BufferWriter();
    body.u16("png-thing".length).utf8("png-thing");
    body.u32(TextureCompression.Png);
    body.raw(new Uint8Array([1, 2, 3, 4]));
    const payload = parseGeometryBody(
      GeometryPayloadType.Texture,
      99n,
      body.toUint8Array(),
    );
    expect(payload.kind).toBe(GeometryPayloadType.Texture);
    if (payload.kind === GeometryPayloadType.Texture) {
      expect(payload.uid).toBe(99n);
      expect(payload.name).toBe("png-thing");
      expect(payload.compression).toBe(TextureCompression.Png);
      expect(Array.from(payload.data)).toEqual([1, 2, 3, 4]);
    }
  });

  it("rejects RemoveNodes (which has no uid header and never travels by HTTP)", () => {
    expect(() =>
      parseGeometryBody(GeometryPayloadType.RemoveNodes, 0n, new Uint8Array()),
    ).toThrow(/out-of-band/);
  });
});

describe("parseGeometryChunk — Skeleton", () => {
  it("decodes a bone uid list", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Skeleton).u64(900n);
      writeString(w, "rig");
      w.u64(3n).u64(901n).u64(902n).u64(903n);
    });
    const payload = parseGeometryChunk(packet);
    if (payload.kind === GeometryPayloadType.Skeleton) {
      expect(payload.boneIds).toEqual([901n, 902n, 903n]);
    }
  });
});

describe("parseGeometryChunk — Animation", () => {
  it("decodes a single-track keyframe list", () => {
    const packet = chunk((w) => {
      w.u8(GeometryPayloadType.Animation).u64(801n);
      writeString(w, "idle");
      w.f32(1.5); // duration
      w.u64(1n); // 1 track
      w.i16(0); // boneIndex
      w.u16(1).f32(0).vec3(1, 2, 3); // 1 position keyframe
      w.u16(1).f32(0).vec4(0, 0, 0, 1); // 1 rotation keyframe
    });
    const payload = parseGeometryChunk(packet);
    if (payload.kind === GeometryPayloadType.Animation) {
      expect(payload.duration).toBeCloseTo(1.5);
      expect(payload.tracks).toHaveLength(1);
      expect(payload.tracks[0].positionKeyframes[0].value).toEqual([1, 2, 3]);
    }
  });
});
