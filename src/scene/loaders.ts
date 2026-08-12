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
  /** Set instead of `geometry` when the source file is skinned: the whole
   *  glTF scene, bones and `SkinnedMesh` intact.
   *
   *  A skinned mesh cannot survive the flattening the other branch does. Baking
   *  `matrixWorld` into each primitive and dropping the node hierarchy throws away
   *  the bones the skin indices refer to, leaving a body frozen in its bind pose —
   *  which renders correctly right up until something tries to animate it. The
   *  adapter clones this with `SkeletonUtils.clone` so each instance gets its own
   *  skeleton to pose. */
  scene?: THREE.Object3D;
  /** Clips packaged inside the same file. Rarely used: clips normally arrive
   *  separately as AnimationPointers, which is what lets one rig share them. */
  animations?: THREE.AnimationClip[];
  /** VRM humanoid role -> the name of the object filling it, e.g.
   *  `{ hips: "Avatar_Hips", leftUpperArm: "Avatar_LeftArm" }`.
   *
   *  This is the only thing tying a VRM animation to a VRM body. A `.vrma` names its
   *  tracks by humanoid role (`hips.quaternion`); an avatar names its bones however its
   *  author did (`Avatar_Hips`, Mixamo-style here). Nothing in the glTF itself connects
   *  the two — the correspondence lives in the VRM extension, so it is read out here and
   *  carried alongside the rig for the animation layer to rename tracks with. */
  humanoidBones?: Record<string, string>;
}

export interface MeshDecoder {
  /** Decode a single submesh buffer. Returns one or more renderable
   *  primitives (a Draco buffer yields one; a glTF binary may yield many). */
  decode(bytes: Uint8Array): Promise<DecodedMesh[]>;
  /** Decode an animation file (.vrma / .glb) into its clips and the rig they were
   *  authored against. Both are needed: a clip only drives a skeleton whose bones its
   *  tracks name, so where the avatar's rig differs the clip has to be retargeted from
   *  its own source rig onto the target. Returning the clips alone would leave nothing
   *  to retarget *from*. */
  decodeAnimation?(bytes: Uint8Array): Promise<DecodedAnimation>;
  dispose(): void;
}

/** Clips plus the rig they were authored against. */
export interface DecodedAnimation {
  clips: THREE.AnimationClip[];
  /** The clip file's own skeleton, as `SkeletonUtils.retargetClip`'s `source`. */
  source: THREE.Object3D;
  /** VRM humanoid role -> the name of the node filling it, when the file declares it.
   *
   *  A VRM animation's nodes are conventionally *named* for the role they play
   *  (`hips`, `leftUpperArm`), and reading the names is what the 1.0-beta files in use
   *  here allow. But that convention is not the contract: `VRMC_vrm_animation` states
   *  the mapping explicitly as node indices, and a file is free to name its nodes
   *  anything. Prefer the declaration wherever it exists. */
  humanoidBones?: Record<string, string>;
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

/** Placeholder for the `geometry` field of a scene-carrying DecodedMesh, which has
 *  no single geometry of its own. Shared and never disposed: the adapter mounts the
 *  scene instead and never reads this. */
const EMPTY_GEOMETRY = new THREE.BufferGeometry();

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

  async decodeAnimation(bytes: Uint8Array): Promise<DecodedAnimation> {
    if (!isGltfBinary(bytes)) {
      return { clips: [], source: new THREE.Object3D() };
    }
    return decodeGltfAnimations(this.gltf, bytes);
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
        // A skinned file keeps its scene graph. Flattening below would bake each
        // primitive's world matrix and drop the bone hierarchy the skin indices point
        // at, so the mesh would render in its bind pose and could never be posed again.
        let skinned = false;
        gltf.scene.traverse((obj) => {
          if ((obj as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
        });
        if (skinned) {
          resolve([
            {
              geometry: EMPTY_GEOMETRY,
              scene: gltf.scene,
              animations: gltf.animations ?? [],
              humanoidBones: readVrmHumanoidBones(gltf),
              name: gltf.scene.name,
            },
          ]);
          return;
        }
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

/** Read the VRM humanoid map out of a loaded glTF, as `role -> node name`.
 *
 *  Both spec generations are handled because they disagree on shape: VRM 0.x keeps an
 *  array of `{bone, node}`, VRM 1.0 an object keyed by role. `node` is an index into
 *  `json.nodes`, whose `name` is what three gives the corresponding Object3D.
 *
 *  Returns undefined for a non-VRM file, which is not an error — an ordinary skinned
 *  glTF simply has no humanoid roles, and its clips are expected to name its bones. */
function readVrmHumanoidBones(gltf: GLTF): Record<string, string> | undefined {
  const json = (gltf.parser as { json?: GltfJson }).json;
  const humanoid =
    json?.extensions?.VRM?.humanoid ?? json?.extensions?.VRMC_vrm?.humanoid;
  const humanBones = humanoid?.humanBones;
  if (!humanBones || !json?.nodes) return undefined;

  const out: Record<string, string> = {};
  const add = (role: string | undefined, nodeIndex: number | undefined) => {
    if (!role || nodeIndex === undefined) return;
    const name = json.nodes?.[nodeIndex]?.name;
    if (name) out[role] = name;
  };
  if (Array.isArray(humanBones)) {
    for (const hb of humanBones) add(hb.bone, hb.node);
  } else {
    for (const [role, hb] of Object.entries(humanBones)) add(role, hb?.node);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Read the humanoid map a VRM *animation* declares, as `role -> node name`.
 *
 *  Two layouts are in the wild and both are handled, because the released spec moved the
 *  node reference: 1.0 states `humanBones.<role>.node`, while the 1.0-beta files this
 *  client is used with instead carry inline sampler references and no node index at all.
 *  For those, fall back to the naming convention — a beta file's nodes are named for
 *  their roles, which is the only handle it offers.
 *
 *  Returns undefined for a file that is not a VRM animation. */
function readVrmAnimationHumanoidBones(
  gltf: GLTF,
): Record<string, string> | undefined {
  const json = (gltf.parser as { json?: GltfJson }).json;
  const humanBones = json?.extensions?.VRMC_vrm_animation?.humanoid?.humanBones;
  if (!humanBones || !json?.nodes) return undefined;

  const out: Record<string, string> = {};
  for (const [role, entry] of Object.entries(humanBones)) {
    const nodeIndex = entry?.node;
    if (nodeIndex === undefined) continue;
    const name = json.nodes[nodeIndex]?.name;
    if (name) out[role] = name;
  }
  if (Object.keys(out).length) return out;

  // No node indices: a 1.0-beta file. Its roles are its node names, so accept any node
  // whose name matches a role the extension lists.
  for (const role of Object.keys(humanBones)) {
    if (json.nodes.some((n) => n.name === role)) out[role] = role;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The slice of glTF JSON this file reads. GLTFLoader types `parser.json` loosely. */
interface GltfJson {
  nodes?: { name?: string }[];
  extensions?: {
    VRM?: { humanoid?: VrmHumanoid };
    VRMC_vrm?: { humanoid?: VrmHumanoid };
    VRMC_vrm_animation?: {
      humanoid?: { humanBones?: Record<string, { node?: number } | undefined> };
    };
  };
}

interface VrmHumanoid {
  humanBones?:
    | { bone?: string; node?: number }[]
    | Record<string, { node?: number } | undefined>;
}

function decodeGltfAnimations(
  loader: GLTFLoader,
  bytes: Uint8Array,
): Promise<DecodedAnimation> {
  return new Promise((resolve, reject) => {
    const ab = toStandaloneArrayBuffer(bytes);
    loader.parse(
      ab,
      "",
      (gltf: GLTF) => {
        // The scene is kept, not discarded: it is the rig the clips were authored
        // against, and retargeting cannot happen without it.
        gltf.scene.updateMatrixWorld(true);
        resolve({
          clips: gltf.animations ?? [],
          source: gltf.scene,
          humanoidBones: readVrmAnimationHumanoidBones(gltf),
        });
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
