// Tests for the HTTP-resource format resolution: MIME first, then URL
// extension, then magic-byte sniff. Mirrors the dispatch logic in
// src/client.ts `fetchPointer`.

import { describe, expect, it } from "vitest";
import {
  isGltfBinary,
  isJpeg,
  isKtx2,
  isPng,
  resolveMeshFormat,
  resolveTextureFormat,
} from "../src/scene/loaders.js";
import { TextureCompression } from "../src/geometry/payload.js";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const KTX2_MAGIC = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const GLTF_MAGIC = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0, 0, 0]);

describe("magic-byte detectors", () => {
  it("isPng", () => {
    expect(isPng(PNG_MAGIC)).toBe(true);
    expect(isPng(JPEG_MAGIC)).toBe(false);
    expect(isPng(new Uint8Array(0))).toBe(false);
    expect(isPng(new Uint8Array(4))).toBe(false);
  });

  it("isJpeg", () => {
    expect(isJpeg(JPEG_MAGIC)).toBe(true);
    expect(isJpeg(PNG_MAGIC)).toBe(false);
    expect(isJpeg(new Uint8Array(2))).toBe(false);
  });

  it("isKtx2", () => {
    expect(isKtx2(KTX2_MAGIC)).toBe(true);
    expect(isKtx2(PNG_MAGIC)).toBe(false);
    expect(isKtx2(new Uint8Array(11))).toBe(false);
  });

  it("isGltfBinary", () => {
    expect(isGltfBinary(GLTF_MAGIC)).toBe(true);
    expect(isGltfBinary(PNG_MAGIC)).toBe(false);
  });
});

describe("resolveTextureFormat", () => {
  it("prefers MIME over extension over magic", () => {
    // MIME wins even when the URL suggests PNG and the body is JPEG bytes.
    const hint = resolveTextureFormat("image/ktx2", "/foo.png", JPEG_MAGIC);
    expect(hint?.compression).toBe(TextureCompression.Ktx);
  });

  it("uses the URL extension when MIME is missing", () => {
    expect(resolveTextureFormat(null, "/x.ktx2", new Uint8Array(0))?.compression)
      .toBe(TextureCompression.Ktx);
    expect(resolveTextureFormat(null, "/x.png", new Uint8Array(0))?.compression)
      .toBe(TextureCompression.Png);
    expect(resolveTextureFormat(null, "/x.jpg", new Uint8Array(0))?.compression)
      .toBe(TextureCompression.Jpeg);
    expect(resolveTextureFormat(null, "/x.jpeg", new Uint8Array(0))?.compression)
      .toBe(TextureCompression.Jpeg);
  });

  it("uses extension when MIME is application/octet-stream", () => {
    const hint = resolveTextureFormat(
      "application/octet-stream",
      "/cubemap.ktx2",
      KTX2_MAGIC,
    );
    expect(hint?.compression).toBe(TextureCompression.Ktx);
  });

  it("falls back to magic-byte sniff when MIME and extension are unhelpful", () => {
    expect(resolveTextureFormat(null, "/no-ext", KTX2_MAGIC)?.compression)
      .toBe(TextureCompression.Ktx);
    expect(resolveTextureFormat(null, "/no-ext", PNG_MAGIC)?.compression)
      .toBe(TextureCompression.Png);
    expect(resolveTextureFormat(null, "/no-ext", JPEG_MAGIC)?.compression)
      .toBe(TextureCompression.Jpeg);
  });

  it("strips query strings from the URL when reading the extension", () => {
    const hint = resolveTextureFormat(null, "/cubemap.ktx2?v=2", new Uint8Array(0));
    expect(hint?.compression).toBe(TextureCompression.Ktx);
  });

  it("returns null when nothing matches", () => {
    expect(
      resolveTextureFormat("text/html", "/index.html", new Uint8Array([1, 2, 3])),
    ).toBeNull();
  });
});

describe("resolveMeshFormat", () => {
  it("recognises model/gltf-binary MIME", () => {
    expect(
      resolveMeshFormat("model/gltf-binary", "/x", new Uint8Array(0))?.kind,
    ).toBe("mesh-gltf-binary");
  });

  it("recognises .glb and .vrm extensions", () => {
    expect(resolveMeshFormat(null, "/a.glb", new Uint8Array(0))?.kind)
      .toBe("mesh-gltf-binary");
    expect(resolveMeshFormat(null, "/a.vrm", new Uint8Array(0))?.kind)
      .toBe("mesh-gltf-binary");
  });

  it("recognises .gltf as gltf-json", () => {
    expect(resolveMeshFormat(null, "/a.gltf", new Uint8Array(0))?.kind)
      .toBe("mesh-gltf-json");
  });

  it("recognises .mesh / .draco as teleport-native draco", () => {
    expect(resolveMeshFormat(null, "/a.mesh", new Uint8Array(0))?.kind)
      .toBe("mesh-draco");
    expect(resolveMeshFormat(null, "/a.draco", new Uint8Array(0))?.kind)
      .toBe("mesh-draco");
  });

  it("falls back to magic for glb when extension is missing", () => {
    expect(resolveMeshFormat(null, "/no-ext", GLTF_MAGIC)?.kind)
      .toBe("mesh-gltf-binary");
  });

  it("returns null for unrecognised", () => {
    expect(resolveMeshFormat(null, "/a.txt", new Uint8Array([0, 1, 2]))).toBeNull();
  });
});
