// Minimal KTX2 reader for BC6H (vkFormat 143 / 144), used as a fallback
// when three's KTX2Loader rejects the file with "Unsupported vkFormat".
// BC6H is the standard compressed HDR cubemap format; KTX2Loader's
// FORMAT_MAP covers BC1–BC7 *except* BC6H, even though three.js itself
// supports those formats via WEBGL_compressed_texture_bptc.
//
// We only handle the cases this client actually meets:
//   - vkFormat 143 (BC6H UFLOAT) / 144 (BC6H SFLOAT)
//   - supercompressionScheme 0 (no super-compression)
//   - cubemaps (faceCount = 6) and plain 2D textures (faceCount = 1)
//   - any number of mip levels
//   - layerCount = 0 (i.e. not a texture array)
//
// KTX2 container spec:
//   https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html
// BC6H decoding to a renderable THREE.CompressedTexture uses
// three's RGB_BPTC_UNSIGNED_Format / RGB_BPTC_SIGNED_Format constants,
// which the renderer wires up to GL_COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_ARB
// / GL_COMPRESSED_RGB_BPTC_SIGNED_FLOAT_ARB respectively.

import * as THREE from "three";

export const VK_FORMAT_BC6H_UFLOAT_BLOCK = 143;
export const VK_FORMAT_BC6H_SFLOAT_BLOCK = 144;

const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_SIZE = 80;
const LEVEL_INDEX_ENTRY_SIZE = 24;

interface Ktx2Header {
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  supercompressionScheme: number;
}

interface Ktx2LevelIndex {
  byteOffset: number;
  byteLength: number;
  uncompressedByteLength: number;
}

/** Parse the fixed-size KTX2 header. Returns `null` if the magic doesn't
 *  match (i.e. not a KTX2 file at all). */
export function parseKtx2Header(bytes: Uint8Array): Ktx2Header | null {
  if (bytes.byteLength < HEADER_SIZE) return null;
  for (let i = 0; i < KTX2_MAGIC.length; i++) {
    if (bytes[i] !== KTX2_MAGIC[i]) return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    vkFormat: dv.getUint32(12, true),
    // typeSize at 16 — unused for compressed formats
    pixelWidth: dv.getUint32(20, true),
    pixelHeight: dv.getUint32(24, true),
    pixelDepth: dv.getUint32(28, true),
    layerCount: dv.getUint32(32, true),
    faceCount: dv.getUint32(36, true),
    levelCount: dv.getUint32(40, true),
    supercompressionScheme: dv.getUint32(44, true),
  };
}

function parseLevelIndex(
  bytes: Uint8Array,
  levelCount: number,
): Ktx2LevelIndex[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Ktx2LevelIndex[] = [];
  // Level index sits directly after the 80-byte header. Each entry is
  // 24 bytes: byteOffset (u64), byteLength (u64), uncompressedByteLength (u64).
  // The values are LE; we read them as two u32s and combine because JS
  // numbers can't hold u64 exactly but real KTX2 mip offsets stay well
  // under 2^53.
  for (let i = 0; i < levelCount; i++) {
    const base = HEADER_SIZE + i * LEVEL_INDEX_ENTRY_SIZE;
    out.push({
      byteOffset: readU64Number(dv, base),
      byteLength: readU64Number(dv, base + 8),
      uncompressedByteLength: readU64Number(dv, base + 16),
    });
  }
  return out;
}

function readU64Number(dv: DataView, offset: number): number {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  // Compose into a JS number; safe for values < 2^53 (real mip offsets are
  // tens of megabytes at most).
  return hi * 0x1_0000_0000 + lo;
}

/** Attempt to decode a BC6H KTX2 file. Returns:
 *   - a `CompressedCubeTexture` (faceCount 6) or `CompressedTexture` (1),
 *     uploaded as RGB_BPTC_UNSIGNED_Format / RGB_BPTC_SIGNED_Format;
 *   - `null` when the file isn't BC6H or the case isn't supported (e.g.
 *     ZSTD-supercompressed, texture arrays). Caller falls back to the
 *     original KTX2Loader error in that case.
 *
 *  Throws when the file *is* BC6H but the GPU lacks bptc — surfaces the
 *  format problem rather than silently rendering black. */
export function decodeBc6hKtx2(
  bytes: Uint8Array,
  renderer: THREE.WebGLRenderer,
): THREE.Texture | null {
  const header = parseKtx2Header(bytes);
  if (!header) return null;
  if (
    header.vkFormat !== VK_FORMAT_BC6H_UFLOAT_BLOCK &&
    header.vkFormat !== VK_FORMAT_BC6H_SFLOAT_BLOCK
  ) {
    return null;
  }
  if (header.supercompressionScheme !== 0) {
    // Could add ZSTD via three's own ZSTDDecoder later, but every BC6H
    // cubemap we've seen has supercompressionScheme = 0.
    return null;
  }
  if (header.layerCount > 1) {
    // Texture arrays aren't used here; skip.
    return null;
  }
  if (header.faceCount !== 1 && header.faceCount !== 6) {
    return null;
  }
  if (!renderer.extensions.has("EXT_texture_compression_bptc")) {
    throw new Error(
      "BC6H KTX2 cubemap requires EXT_texture_compression_bptc, which this GPU/browser does not advertise",
    );
  }

  const isCube = header.faceCount === 6;
  const format =
    header.vkFormat === VK_FORMAT_BC6H_UFLOAT_BLOCK
      ? THREE.RGB_BPTC_UNSIGNED_Format
      : THREE.RGB_BPTC_SIGNED_Format;
  const levelCount = Math.max(1, header.levelCount);
  const levels = parseLevelIndex(bytes, levelCount);

  // For each face we collect a mipmaps array in order from level 0 (largest)
  // down. KTX2 stores levels in REVERSE order in the file (smallest first)
  // but the levelIndex itself is in canonical (level 0 first) order — see
  // KTX2 spec §3.9.6.
  const faces: { mipmaps: { data: Uint8Array; width: number; height: number }[] }[] =
    [];
  for (let f = 0; f < header.faceCount; f++) {
    faces.push({ mipmaps: [] });
  }

  for (let levelIndex = 0; levelIndex < levelCount; levelIndex++) {
    const level = levels[levelIndex];
    const width = Math.max(1, header.pixelWidth >> levelIndex);
    const height = Math.max(1, header.pixelHeight >> levelIndex);
    // BC6H: 16 bytes per 4x4 block.
    const blockBytes = 16;
    const blocksWide = Math.ceil(width / 4);
    const blocksHigh = Math.ceil(height / 4);
    const faceByteLength = blocksWide * blocksHigh * blockBytes;
    const expectedTotal = faceByteLength * header.faceCount;
    if (level.byteLength !== expectedTotal) {
      // Layout we don't understand (e.g. padding rules differ for some
      // generator). Bail to keep the data sane.
      return null;
    }
    for (let f = 0; f < header.faceCount; f++) {
      const faceOffset = level.byteOffset + f * faceByteLength;
      const faceBytes = bytes.subarray(faceOffset, faceOffset + faceByteLength);
      faces[f].mipmaps.push({ data: faceBytes, width, height });
    }
  }

  if (isCube) {
    // CompressedCubeTexture expects an array of 6 image entries where each
    // image.mipmaps[0] is the level-0 face data. Three's ctor wires the
    // mip pyramid into texture.mipmaps via image[i].mipmaps after the fact;
    // matching how three's own KTX2Loader builds raw compressed cubemaps.
    const tex = new THREE.CompressedCubeTexture(
      faces.map((face) => ({
        data: face.mipmaps[0].data,
        width: face.mipmaps[0].width,
        height: face.mipmaps[0].height,
      })) as unknown as THREE.CompressedTextureMipmap[],
      format as THREE.CompressedPixelFormat,
      THREE.HalfFloatType,
    );
    // Stitch per-face mip pyramids — three's CompressedCubeTexture reads
    // mip levels off each face image's `mipmaps` array.
    (tex.image as unknown as { mipmaps: unknown }[]).forEach((img, i) => {
      img.mipmaps = faces[i].mipmaps;
    });
    tex.minFilter =
      levelCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.LinearSRGBColorSpace; // HDR cubemaps are linear
    tex.needsUpdate = true;
    return tex;
  }

  const tex = new THREE.CompressedTexture(
    faces[0].mipmaps as unknown as THREE.CompressedTextureMipmap[],
    header.pixelWidth,
    header.pixelHeight,
    format as THREE.CompressedPixelFormat,
    THREE.HalfFloatType,
  );
  tex.minFilter =
    levelCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
