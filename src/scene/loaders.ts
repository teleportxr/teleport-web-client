// Decoders that turn the raw bytes carried by Mesh / Texture payloads into
// THREE.js objects. Pluggable so consumers can swap in self-hosted WASM
// transcoders, custom KTX2 backends, etc.

import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { TextureCompression } from "../geometry/payload.js";
import { decodeBc6hKtx2 } from "./ktx2-bc6h.js";

/** A mesh primitive ready to render: a BufferGeometry plus an optional
 *  baked-in material. When `material` is undefined the resolver supplies one
 *  (typically from a streamed protocol Material payload). glTF-sourced meshes
 *  fill it in; raw Draco meshes leave it for the protocol material. */
export interface DecodedMesh {
  geometry: THREE.BufferGeometry;
  material?: THREE.Material;
  /** Local transform of the source node within the source file, baked into
   *  the geometry by `applyMatrix4` would lose mesh-instance reuse — so we
   *  return it alongside the geometry instead, for the adapter to apply. */
  transform?: THREE.Matrix4;
  name?: string;
}

export interface MeshDecoder {
  /** Decode a single submesh buffer. Returns one or more renderable
   *  primitives (a Draco buffer yields one; a glTF binary may yield many). */
  decode(bytes: Uint8Array): Promise<DecodedMesh[]>;
  dispose(): void;
}

export interface TextureDecoder {
  decode(
    compression: TextureCompression,
    bytes: Uint8Array,
  ): Promise<THREE.Texture>;
  /** KTX2Loader needs `renderer.capabilities` to pick a transcode target. */
  attachRenderer(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

const GLTF_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// KTX2 magic: «KTX 20»\r\n\x1A\n
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** True when the buffer is a glTF binary file (`.glb`). */
export function isGltfBinary(bytes: Uint8Array): boolean {
  return startsWith(bytes, GLTF_MAGIC);
}

/** True when the buffer is a PNG file. */
export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_MAGIC);
}

/** True when the buffer is a JPEG file. */
export function isJpeg(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_MAGIC);
}

/** True when the buffer is a KTX 2.0 container. */
export function isKtx2(bytes: Uint8Array): boolean {
  return startsWith(bytes, KTX2_MAGIC);
}

export type TextureFormatHint =
  | { kind: "texture"; compression: TextureCompression };

export type MeshFormatHint =
  | { kind: "mesh-gltf-binary" }
  | { kind: "mesh-gltf-json" }
  | { kind: "mesh-draco" };

/** Map a fetched resource to a Texture format hint, using MIME first, then
 *  the URL extension, then magic bytes. Returns `null` when the format
 *  isn't a recognised image type (caller decides how to surface the
 *  failure — typically by sending ResourceLost). */
export function resolveTextureFormat(
  mime: string | null,
  url: string,
  bytes: Uint8Array,
): TextureFormatHint | null {
  // 1) MIME, when informative.
  if (mime && mime !== "application/octet-stream") {
    switch (mime) {
      case "image/ktx2":
      case "image/ktx":
        return tex(TextureCompression.Ktx);
      case "image/png":
        return tex(TextureCompression.Png);
      case "image/jpeg":
      case "image/jpg":
        return tex(TextureCompression.Jpeg);
    }
  }
  // 2) URL extension.
  const ext = extensionOf(url);
  switch (ext) {
    case "ktx2":
    case "ktx":
      return tex(TextureCompression.Ktx);
    case "png":
      return tex(TextureCompression.Png);
    case "jpg":
    case "jpeg":
      return tex(TextureCompression.Jpeg);
  }
  // 3) Magic-byte sniff (last resort).
  if (isKtx2(bytes)) return tex(TextureCompression.Ktx);
  if (isPng(bytes)) return tex(TextureCompression.Png);
  if (isJpeg(bytes)) return tex(TextureCompression.Jpeg);
  return null;
}

/** Map a fetched resource to a Mesh format hint. Same priority as
 *  `resolveTextureFormat`. */
export function resolveMeshFormat(
  mime: string | null,
  url: string,
  bytes: Uint8Array,
): MeshFormatHint | null {
  if (mime && mime !== "application/octet-stream") {
    switch (mime) {
      case "model/gltf-binary":
        return { kind: "mesh-gltf-binary" };
      case "model/gltf+json":
        return { kind: "mesh-gltf-json" };
    }
  }
  const ext = extensionOf(url);
  switch (ext) {
    case "glb":
    case "vrm":
      return { kind: "mesh-gltf-binary" };
    case "gltf":
      return { kind: "mesh-gltf-json" };
    case "draco":
    case "mesh":
    case "mesh_compressed":
      return { kind: "mesh-draco" };
  }
  if (isGltfBinary(bytes)) return { kind: "mesh-gltf-binary" };
  return null;
}

function tex(compression: TextureCompression): TextureFormatHint {
  return { kind: "texture", compression };
}

function extensionOf(url: string): string {
  // Strip query / fragment, then take everything after the final '.'.
  const noQuery = url.split(/[?#]/, 1)[0];
  const slash = noQuery.lastIndexOf("/");
  const tail = slash === -1 ? noQuery : noQuery.slice(slash + 1);
  const dot = tail.lastIndexOf(".");
  return dot === -1 ? "" : tail.slice(dot + 1).toLowerCase();
}

/** Default mesh decoder: dispatches on the buffer's leading magic. glTF
 *  binaries go through three's GLTFLoader (and bring their own materials
 *  and textures with them); everything else is treated as a raw Draco
 *  buffer and decoded with DRACOLoader. The DRACOLoader is shared with the
 *  GLTFLoader for Draco-compressed glTFs. */
export class DefaultMeshDecoder implements MeshDecoder {
  private readonly draco: DRACOLoader;
  private readonly gltf: GLTFLoader;

  constructor(
    decoderPath: string = "https://www.gstatic.com/draco/v1/decoders/",
  ) {
    this.draco = new DRACOLoader();
    this.draco.setDecoderPath(decoderPath);
    this.draco.preload();
    this.gltf = new GLTFLoader();
    this.gltf.setDRACOLoader(this.draco);
  }

  async decode(bytes: Uint8Array): Promise<DecodedMesh[]> {
    if (isGltfBinary(bytes)) {
      return decodeGltf(this.gltf, bytes);
    }
    const geo = await decodeDraco(this.draco, bytes);
    return [{ geometry: geo }];
  }

  dispose(): void {
    this.draco.dispose();
  }
}

/** Default texture decoder. Uses `createImageBitmap` for PNG/JPEG and
 *  KTX2Loader for KTX2. Call `attachRenderer(renderer)` after the
 *  `WebGLRenderer` is created so KTX2Loader can pick a compressed-texture
 *  format the GPU actually supports. */
export class DefaultTextureDecoder implements TextureDecoder {
  private readonly ktx2: KTX2Loader;
  private renderer: THREE.WebGLRenderer | null = null;

  constructor(
    ktx2TranscoderPath: string = `https://unpkg.com/three@${THREE.REVISION}/examples/jsm/libs/basis/`,
  ) {
    this.ktx2 = new KTX2Loader();
    this.ktx2.setTranscoderPath(ktx2TranscoderPath);
  }

  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.ktx2.detectSupport(renderer);
    this.renderer = renderer;
  }

  async decode(
    compression: TextureCompression,
    bytes: Uint8Array,
  ): Promise<THREE.Texture> {
    switch (compression) {
      case TextureCompression.Png:
      case TextureCompression.MultiplePng:
        return decodeImageBitmap(bytes, "image/png");
      case TextureCompression.Jpeg:
        return decodeImageBitmap(bytes, "image/jpeg");
      case TextureCompression.Ktx:
        if (!this.renderer) {
          throw new Error(
            "KTX2 texture arrived but DefaultTextureDecoder has no renderer attached",
          );
        }
        return decodeKtx2WithBc6hFallback(this.ktx2, this.renderer, bytes);
      case TextureCompression.Uncompressed:
      default:
        throw new Error(`unsupported texture compression: ${compression}`);
    }
  }

  dispose(): void {
    this.ktx2.dispose();
  }
}

function decodeDraco(
  loader: DRACOLoader,
  bytes: Uint8Array,
): Promise<THREE.BufferGeometry> {
  return new Promise((resolve, reject) => {
    const ab = toStandaloneArrayBuffer(bytes);
    try {
      loader.parse(ab, resolve, (err: unknown) => reject(err as Error));
    } catch (err) {
      reject(err as Error);
    }
  });
}

function decodeGltf(
  loader: GLTFLoader,
  bytes: Uint8Array,
): Promise<DecodedMesh[]> {
  return new Promise((resolve, reject) => {
    const ab = toStandaloneArrayBuffer(bytes);
    loader.parse(
      ab,
      "",
      (gltf: GLTF) => {
        const out: DecodedMesh[] = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          // A glTF primitive maps to one (geometry, material) pair. For
          // multi-material meshes Three encodes groups inside the same
          // BufferGeometry; we just emit one DecodedMesh per material slot
          // and let the adapter assemble the visual.
          mats.forEach((mat) => {
            out.push({
              geometry: mesh.geometry,
              material: mat as THREE.Material,
              transform: mesh.matrixWorld.clone(),
              name: mesh.name,
            });
          });
        });
        resolve(out);
      },
      (err: unknown) => reject(err as Error),
    );
  });
}

async function decodeImageBitmap(
  bytes: Uint8Array,
  mime: string,
): Promise<THREE.Texture> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime });
  const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" });
  const tex = new THREE.Texture(bitmap);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function decodeKtx2(
  loader: KTX2Loader,
  bytes: Uint8Array,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const ab = toStandaloneArrayBuffer(bytes);
    loader.parse(
      ab,
      (texture) => {
        texture.needsUpdate = true;
        resolve(texture);
      },
      (err: unknown) => reject(err as Error),
    );
  });
}

/** Three's KTX2Loader covers every BCn format except BC6H, even though the
 *  GPU side of three.js handles BC6H fine (via EXT_texture_compression_bptc).
 *  When KTX2Loader throws `Unsupported vkFormat: 143|144`, try our
 *  minimal BC6H reader; if that produces a CompressedTexture, use it.
 *  Otherwise re-throw the original error so callers see the real problem. */
async function decodeKtx2WithBc6hFallback(
  loader: KTX2Loader,
  renderer: THREE.WebGLRenderer,
  bytes: Uint8Array,
): Promise<THREE.Texture> {
  try {
    return await decodeKtx2(loader, bytes);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!/Unsupported vkFormat: (143|144)/.test(msg)) {
      throw err;
    }
    const fallback = decodeBc6hKtx2(bytes, renderer);
    if (!fallback) throw err;
    return fallback;
  }
}

/** Copy a Uint8Array into a freshly allocated ArrayBuffer. Loaders that
 *  transfer the buffer to a worker need to own it; views over a shared or
 *  aliased buffer break in that path. */
function toStandaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}
