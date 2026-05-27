// Tests for the BC6H fallback's header / level-index parsing. The end-to-end
// CompressedCubeTexture construction needs a real WebGLRenderer (and the GPU
// extension EXT_texture_compression_bptc), so the texture-construction path
// is exercised only in the browser. Here we cover everything that runs before
// the THREE.WebGLRenderer dependency.

import { describe, expect, it } from "vitest";
import {
  VK_FORMAT_BC6H_SFLOAT_BLOCK,
  VK_FORMAT_BC6H_UFLOAT_BLOCK,
  decodeBc6hKtx2,
  parseKtx2Header,
} from "../src/scene/ktx2-bc6h.js";

const KTX2_MAGIC = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** Build the fixed 80-byte KTX2 header for a small synthetic file. */
function makeHeader(opts: {
  vkFormat: number;
  width: number;
  height: number;
  faceCount: number;
  levelCount: number;
  supercompressionScheme?: number;
  layerCount?: number;
}): Uint8Array {
  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  buf.set(KTX2_MAGIC, 0);
  dv.setUint32(12, opts.vkFormat, true);
  dv.setUint32(16, 1, true); // typeSize
  dv.setUint32(20, opts.width, true);
  dv.setUint32(24, opts.height, true);
  dv.setUint32(28, 0, true); // pixelDepth
  dv.setUint32(32, opts.layerCount ?? 0, true);
  dv.setUint32(36, opts.faceCount, true);
  dv.setUint32(40, opts.levelCount, true);
  dv.setUint32(44, opts.supercompressionScheme ?? 0, true);
  return buf;
}

describe("parseKtx2Header", () => {
  it("returns null for a non-KTX2 buffer", () => {
    expect(parseKtx2Header(new Uint8Array(80))).toBeNull();
    expect(parseKtx2Header(new Uint8Array(0))).toBeNull();
    expect(parseKtx2Header(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("decodes a BC6H cubemap header", () => {
    const bytes = makeHeader({
      vkFormat: VK_FORMAT_BC6H_UFLOAT_BLOCK,
      width: 256,
      height: 256,
      faceCount: 6,
      levelCount: 9,
    });
    const h = parseKtx2Header(bytes);
    expect(h).not.toBeNull();
    expect(h!.vkFormat).toBe(143);
    expect(h!.pixelWidth).toBe(256);
    expect(h!.faceCount).toBe(6);
    expect(h!.levelCount).toBe(9);
    expect(h!.supercompressionScheme).toBe(0);
  });
});

describe("decodeBc6hKtx2", () => {
  const fakeRenderer = {
    extensions: { has: (_name: string) => true },
  } as unknown as Parameters<typeof decodeBc6hKtx2>[1];

  it("returns null for non-KTX2 input", () => {
    expect(decodeBc6hKtx2(new Uint8Array(0), fakeRenderer)).toBeNull();
  });

  it("returns null for a non-BC6H vkFormat (lets KTX2Loader handle it)", () => {
    const bytes = makeHeader({
      vkFormat: 137 /* BC3_UNORM */,
      width: 16,
      height: 16,
      faceCount: 1,
      levelCount: 1,
    });
    expect(decodeBc6hKtx2(bytes, fakeRenderer)).toBeNull();
  });

  it("returns null when ZSTD supercompression is present (unsupported in this path)", () => {
    const bytes = makeHeader({
      vkFormat: VK_FORMAT_BC6H_UFLOAT_BLOCK,
      width: 16,
      height: 16,
      faceCount: 6,
      levelCount: 1,
      supercompressionScheme: 2 /* ZSTD */,
    });
    expect(decodeBc6hKtx2(bytes, fakeRenderer)).toBeNull();
  });

  it("returns null when layerCount > 1 (texture arrays not supported)", () => {
    const bytes = makeHeader({
      vkFormat: VK_FORMAT_BC6H_SFLOAT_BLOCK,
      width: 16,
      height: 16,
      faceCount: 1,
      levelCount: 1,
      layerCount: 4,
    });
    expect(decodeBc6hKtx2(bytes, fakeRenderer)).toBeNull();
  });

  it("throws a clear error when the GPU lacks EXT_texture_compression_bptc", () => {
    const noBptcRenderer = {
      extensions: { has: () => false },
    } as unknown as Parameters<typeof decodeBc6hKtx2>[1];
    // Build a one-level 4×4 BC6H cubemap fixture: 16 bytes/face × 6 faces.
    const header = makeHeader({
      vkFormat: VK_FORMAT_BC6H_UFLOAT_BLOCK,
      width: 4,
      height: 4,
      faceCount: 6,
      levelCount: 1,
    });
    const faceBytes = 16; // 1 BC6H block
    const dataLength = faceBytes * 6;
    const levelIndex = new Uint8Array(24);
    const liDv = new DataView(levelIndex.buffer);
    const dataOffset = 80 + 24; // header + 1 levelIndex entry
    liDv.setBigUint64(0, BigInt(dataOffset), true);
    liDv.setBigUint64(8, BigInt(dataLength), true);
    liDv.setBigUint64(16, BigInt(dataLength), true);
    const buf = new Uint8Array(dataOffset + dataLength);
    buf.set(header, 0);
    buf.set(levelIndex, 80);
    expect(() => decodeBc6hKtx2(buf, noBptcRenderer)).toThrow(/bptc/);
  });
});
