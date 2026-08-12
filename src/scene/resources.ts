// Memoised resolver: turns geometry-payload uids (Mesh / Material / Texture)
// into THREE.js objects on demand, gated on the payload arriving in the
// ResourceCache. Each uid is resolved at most once; subsequent calls return
// the same promise.

import * as THREE from "three";
import { GeometryPayloadType, type Uid } from "../wire/types.js";
import {
  MaterialMode,
  TextureCompression,
  type MaterialPayload,
} from "../geometry/payload.js";
import type { ResourceCache } from "./cache.js";
import type { DecodedMesh, MeshDecoder, TextureDecoder } from "./loaders.js";

export interface ResourceResolverOptions {
  meshDecoder: MeshDecoder;
  textureDecoder: TextureDecoder;
}

const RESOLVED_NULL_TEXTURE: Promise<THREE.Texture | null> = Promise.resolve(null);

export class ResourceResolver {
  private readonly cache: ResourceCache;
  private readonly meshDecoder: MeshDecoder;
  private readonly textureDecoder: TextureDecoder;
  private readonly meshes = new Map<bigint, Promise<DecodedMesh[]>>();
  private readonly textures = new Map<bigint, Promise<THREE.Texture | null>>();
  private readonly materials = new Map<bigint, Promise<THREE.Material>>();

  constructor(cache: ResourceCache, opts: ResourceResolverOptions) {
    this.cache = cache;
    this.meshDecoder = opts.meshDecoder;
    this.textureDecoder = opts.textureDecoder;
  }

  /** Resolve a list of renderable submeshes for `uid`. Each entry may bring
   *  its own embedded material (e.g. from a glTF source); when it does the
   *  resolver/adapter prefers it over any protocol Material payload. */
  resolveMesh(uid: Uid): Promise<DecodedMesh[]> {
    if (uid === 0n) return Promise.resolve([]);
    let p = this.meshes.get(uid);
    if (p) return p;
    p = new Promise((resolve, reject) => {
      this.cache.whenAvailable(uid, GeometryPayloadType.Mesh, (payload) => {
        Promise.all(payload.submeshes.map((sm) => this.meshDecoder.decode(sm.buffer)))
          .then((groups) => resolve(groups.flat()))
          .catch(reject);
      });
    });
    this.meshes.set(uid, p);
    return p;
  }

  /** Resolve a single texture by uid. `0` resolves to `null` (no texture). */
  resolveTexture(uid: Uid): Promise<THREE.Texture | null> {
    if (uid === 0n) return RESOLVED_NULL_TEXTURE;
    let p = this.textures.get(uid);
    if (p) return p;
    p = new Promise<THREE.Texture | null>((resolve, reject) => {
      this.cache.whenAvailable(uid, GeometryPayloadType.Texture, (payload) => {
        this.textureDecoder
          .decode(payload.compression, payload.data)
          .then((tex) => {
            tex.name = payload.name;
            // The frame the contents are laid out in, for callers that sample it as a
            // cubemap. Carried on userData because it is ours, not Three's; see scene/axes.ts.
            if (payload.axesStandard !== undefined) {
              tex.userData.teleportAxesStandard = payload.axesStandard;
            }
            resolve(tex);
          })
          .catch(reject);
      });
    });
    this.textures.set(uid, p);
    return p;
  }

  /** Resolve a material by uid. `0` returns a neutral default. */
  resolveMaterial(uid: Uid): Promise<THREE.Material> {
    if (uid === 0n) return Promise.resolve(neutralMaterial());
    let p = this.materials.get(uid);
    if (p) return p;
    p = new Promise<THREE.Material>((resolve, reject) => {
      this.cache.whenAvailable(uid, GeometryPayloadType.Material, (payload) => {
        this.buildMaterial(payload).then(resolve).catch(reject);
      });
    });
    this.materials.set(uid, p);
    return p;
  }

  private async buildMaterial(payload: MaterialPayload): Promise<THREE.Material> {
    // A missing texture (decode failure, 404, unsupported compression) must not
    // sink the whole material — fall back to the colour/factor channels only.
    const [baseColor, normal, mr, emissive] = await Promise.all([
      this.resolveTexture(payload.baseColorTexture.index).catch(() => null),
      this.resolveTexture(payload.normalTexture.index).catch(() => null),
      this.resolveTexture(payload.metallicRoughnessTexture.index).catch(() => null),
      this.resolveTexture(payload.emissiveTexture.index).catch(() => null),
    ]);

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(
        payload.baseColorFactor[0],
        payload.baseColorFactor[1],
        payload.baseColorFactor[2],
      ),
      opacity: payload.baseColorFactor[3],
      transparent: payload.materialMode === MaterialMode.Transparent,
      alphaTest: payload.materialMode === MaterialMode.Masked ? 0.5 : 0,
      metalness: payload.metallicFactor,
      roughness: payload.roughnessMultiplier,
      emissive: new THREE.Color(
        payload.emissiveFactor[0],
        payload.emissiveFactor[1],
        payload.emissiveFactor[2],
      ),
      side: payload.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (baseColor) mat.map = baseColor;
    if (normal) mat.normalMap = normal;
    if (mr) {
      // glTF convention: G channel = roughness, B channel = metalness. Three.js
      // applies them via the same texture slot when both maps are equal.
      mat.metalnessMap = mr;
      mat.roughnessMap = mr;
    }
    if (emissive) mat.emissiveMap = emissive;
    mat.name = payload.name;
    return mat;
  }
}

function neutralMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    roughness: 0.8,
    metalness: 0.0,
  });
}

/** Texture compressions the default decoder currently understands. Exposed
 *  so consumers writing custom decoders know what to handle. */
export const SUPPORTED_TEXTURE_COMPRESSIONS: readonly TextureCompression[] = [
  TextureCompression.Png,
  TextureCompression.Jpeg,
  TextureCompression.Ktx,
];
