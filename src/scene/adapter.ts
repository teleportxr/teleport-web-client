// Maps the Teleport scene graph (NodePayload chunks) onto a THREE.Object3D
// tree under a single root group.
//
// Resource resolution:
//   * Nodes:            full transform + parent/child wiring.
//   * Light components: mapped to THREE.PointLight / DirectionalLight /
//                       SpotLight based on lightType.
//   * Mesh components:  decoded asynchronously via a ResourceResolver. The
//                       mesh node is mounted immediately as an empty Group
//                       so the hierarchy is visible at once; THREE.Mesh
//                       children appear under it as the mesh + materials
//                       resolve. A small wireframe cube acts as a
//                       fallback when no resolver is configured.
//   * TextCanvas/Link:  not yet rendered.

import * as THREE from "three";
import { GeometryPayloadType, type Uid } from "../wire/types.js";
import {
  NodeDataType,
  type GeometryPayload,
  type LightComponent,
  type MeshComponent,
  type NodePayload,
} from "../geometry/payload.js";
import type { ResourceCache } from "./cache.js";
import type { ResourceResolver } from "./resources.js";

interface MountedNode {
  uid: Uid;
  object: THREE.Object3D;
  /** Component visual (Light / Mesh group / etc), parented under `object`. */
  visual: THREE.Object3D | null;
  /** Bumped each time updateVisual replaces `visual`; lets in-flight async
   *  mesh populates abort if the node was re-applied or removed. */
  visualGeneration: number;
  parentId: Uid;
}

export interface SceneAdapterOptions {
  /** When provided, Mesh components decode through this resolver and the
   *  placeholder cube is no longer used. */
  resolver?: ResourceResolver;
}

export class SceneAdapter {
  readonly root: THREE.Group;
  private readonly cache: ResourceCache;
  private readonly resolver: ResourceResolver | null;
  private readonly mounted = new Map<bigint, MountedNode>();
  /** Nodes whose parent has not yet been seen — re-parented when it lands. */
  private readonly orphans = new Map<bigint, Set<bigint>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    cache: ResourceCache,
    optsOrRoot?: SceneAdapterOptions | THREE.Group,
  ) {
    this.cache = cache;
    // Back-compat: previous signature was `new SceneAdapter(cache, root?)`.
    if (optsOrRoot instanceof THREE.Group) {
      this.root = optsOrRoot;
      this.resolver = null;
    } else {
      this.root = new THREE.Group();
      this.resolver = optsOrRoot?.resolver ?? null;
    }
    this.root.name = "teleport-root";
  }

  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.cache.onPayload((p) => this.onPayload(p));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Clear every mounted node; used when the session ends. */
  clear(): void {
    for (const { object } of this.mounted.values()) {
      object.removeFromParent();
      disposeRecursive(object);
    }
    this.mounted.clear();
    this.orphans.clear();
  }

  private onPayload(payload: GeometryPayload): void {
    if (payload.kind === GeometryPayloadType.Node) {
      this.applyNode(payload);
    } else if (payload.kind === GeometryPayloadType.RemoveNodes) {
      for (const uid of payload.uids) this.removeNode(uid);
    }
  }

  private applyNode(payload: NodePayload): void {
    let entry = this.mounted.get(payload.uid);
    if (!entry) {
      const object = new THREE.Group();
      object.name = payload.name || `uid:${payload.uid}`;
      entry = {
        uid: payload.uid,
        object,
        visual: null,
        visualGeneration: 0,
        parentId: 0n,
      };
      this.mounted.set(payload.uid, entry);
    } else {
      entry.object.name = payload.name || entry.object.name;
    }

    const t = payload.localTransform;
    entry.object.position.set(t.position[0], t.position[1], t.position[2]);
    entry.object.quaternion.set(
      t.rotation[0],
      t.rotation[1],
      t.rotation[2],
      t.rotation[3],
    );
    entry.object.scale.set(t.scale[0], t.scale[1], t.scale[2]);

    this.reparent(entry, payload.parentId);
    this.updateVisual(entry, payload);
    this.adoptOrphans(payload.uid);
  }

  private updateVisual(entry: MountedNode, payload: NodePayload): void {
    if (entry.visual) {
      entry.visual.removeFromParent();
      disposeRecursive(entry.visual);
      entry.visual = null;
    }
    entry.visualGeneration += 1;
    const c = payload.component;
    if (!c) return;
    if (c.kind === NodeDataType.Light) {
      entry.visual = buildLight(c);
      entry.object.add(entry.visual);
    } else if (c.kind === NodeDataType.Mesh) {
      // Always mount a Group immediately so the hierarchy is visible even
      // before mesh + material decoding completes.
      const group = new THREE.Group();
      group.name = `mesh:${c.meshUid}`;
      entry.visual = group;
      entry.object.add(group);
      if (this.resolver) {
        this.populateMesh(group, c, entry, entry.visualGeneration).catch((err) =>
          console.warn(
            `teleport-web-client: mesh ${c.meshUid} failed to resolve:`,
            err,
          ),
        );
      } else {
        group.add(new THREE.Mesh(PLACEHOLDER_GEOMETRY, PLACEHOLDER_MATERIAL));
      }
    }
  }

  private async populateMesh(
    group: THREE.Group,
    c: MeshComponent,
    entry: MountedNode,
    generation: number,
  ): Promise<void> {
    const resolver = this.resolver!;
    const [decoded, ...protocolMaterials] = await Promise.all([
      resolver.resolveMesh(c.meshUid),
      ...c.materials.map((uid) => resolver.resolveMaterial(uid)),
    ]);
    // Abort if the node has been re-applied or removed while we were waiting.
    if (entry.visualGeneration !== generation || entry.visual !== group) {
      for (const dm of decoded) dm.geometry.dispose();
      for (const m of protocolMaterials) m.dispose();
      return;
    }
    for (let i = 0; i < decoded.length; i++) {
      const dm = decoded[i];
      // Prefer the material the decoder baked in (e.g. from a glTF source);
      // fall back to a protocol Material payload referenced from the mesh
      // component; final fallback is a neutral grey.
      const mat =
        dm.material ??
        protocolMaterials[i] ??
        protocolMaterials[0] ??
        neutralMaterial();
      const mesh = new THREE.Mesh(dm.geometry, mat);
      mesh.name = dm.name || `${c.meshUid}:submesh${i}`;
      if (dm.transform) {
        mesh.applyMatrix4(dm.transform);
      }
      group.add(mesh);
    }
  }

  private reparent(entry: MountedNode, parentId: Uid): void {
    if (entry.parentId === parentId && entry.object.parent) return;
    entry.object.removeFromParent();
    entry.parentId = parentId;
    if (parentId === 0n) {
      this.root.add(entry.object);
      return;
    }
    const parent = this.mounted.get(parentId);
    if (parent) {
      parent.object.add(entry.object);
    } else {
      // Park under the root until the parent node arrives.
      this.root.add(entry.object);
      const set = this.orphans.get(parentId) ?? new Set<bigint>();
      set.add(entry.uid);
      this.orphans.set(parentId, set);
    }
  }

  private adoptOrphans(parentId: Uid): void {
    const set = this.orphans.get(parentId);
    if (!set) return;
    this.orphans.delete(parentId);
    const parent = this.mounted.get(parentId);
    if (!parent) return;
    for (const uid of set) {
      const child = this.mounted.get(uid);
      if (!child) continue;
      child.object.removeFromParent();
      parent.object.add(child.object);
    }
  }

  private removeNode(uid: Uid): void {
    const entry = this.mounted.get(uid);
    if (!entry) return;
    entry.visualGeneration += 1;
    entry.object.removeFromParent();
    disposeRecursive(entry.object);
    this.mounted.delete(uid);
    for (const [parentId, set] of this.orphans) {
      set.delete(uid);
      if (!set.size) this.orphans.delete(parentId);
    }
    this.cache.removeNode(uid);
  }
}

function buildLight(c: LightComponent): THREE.Object3D {
  const colour = new THREE.Color(c.colour[0], c.colour[1], c.colour[2]);
  // lightType: server-side enum values aren't documented for the wire as a
  // fixed table; pick a reasonable mapping by index until that's pinned down.
  // 1 = directional, 2 = point, 3 = spot (matches the common convention).
  let light: THREE.Light;
  switch (c.lightType) {
    case 1:
      light = new THREE.DirectionalLight(colour, c.colour[3]);
      (light as THREE.DirectionalLight).target.position.set(
        c.direction[0],
        c.direction[1],
        c.direction[2],
      );
      break;
    case 3:
      light = new THREE.SpotLight(colour, c.colour[3], c.range);
      break;
    case 2:
    default:
      light = new THREE.PointLight(colour, c.colour[3], c.range);
      break;
  }
  return light;
}

const PLACEHOLDER_GEOMETRY = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const PLACEHOLDER_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x4488ff,
  wireframe: true,
});

function neutralMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    roughness: 0.8,
    metalness: 0.0,
  });
}

function disposeRecursive(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.geometry && m.geometry !== PLACEHOLDER_GEOMETRY) {
      m.geometry.dispose();
    }
    const mat = m.material;
    if (Array.isArray(mat)) {
      for (const x of mat) if (x !== PLACEHOLDER_MATERIAL) x.dispose();
    } else if (mat && mat !== PLACEHOLDER_MATERIAL) {
      (mat as THREE.Material).dispose();
    }
  });
}
