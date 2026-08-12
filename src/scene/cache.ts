// In-memory registry of decoded geometry-channel payloads, keyed by avs::uid.
//
// The cache is the single source of truth for "have we received resource X".
// Subscribers (e.g. the Three.js adapter) call `whenAvailable(uid, kind, cb)`
// and receive the payload either immediately (if cached) or when it lands.

import { type AxesStandard, GeometryPayloadType, type Uid } from "../wire/types.js";
import type {
  AnimationPayload,
  FontAtlasPayload,
  GeometryPayload,
  MaterialPayload,
  MeshPayload,
  NodePayload,
  SkeletonPayload,
  TextCanvasPayload,
  TexturePayload,
} from "../geometry/payload.js";

type PayloadOfKind<K extends GeometryPayloadType> = Extract<
  GeometryPayload,
  { kind: K }
>;

interface Waiter {
  kind: GeometryPayloadType;
  cb: (payload: GeometryPayload) => void;
}

/** A pending pointer: we've seen a TexturePointer/MeshPointer chunk and need
 *  to fetch + decode the body. */
export interface PendingPointer {
  uid: Uid;
  url: string;
  kind: GeometryPayloadType.TexturePointer | GeometryPayloadType.MeshPointer;
  /** The frame the referenced asset is laid out in, as the pointer declared it. */
  axesStandard: AxesStandard;
}

export class ResourceCache {
  readonly nodes = new Map<bigint, NodePayload>();
  readonly meshes = new Map<bigint, MeshPayload>();
  readonly materials = new Map<bigint, MaterialPayload>();
  readonly textures = new Map<bigint, TexturePayload>();
  readonly animations = new Map<bigint, AnimationPayload>();
  readonly skeletons = new Map<bigint, SkeletonPayload>();
  readonly fontAtlases = new Map<bigint, FontAtlasPayload>();
  readonly textCanvases = new Map<bigint, TextCanvasPayload>();
  /** Pointer URLs the caller is responsible for fetching, indexed by uid. */
  readonly pendingPointers = new Map<bigint, PendingPointer>();

  private readonly waiters = new Map<bigint, Waiter[]>();
  private readonly listeners = new Set<(p: GeometryPayload) => void>();

  /** Notified for every payload added to the cache (Node/Mesh/...). */
  onPayload(listener: (p: GeometryPayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve `cb` when a payload of the given kind for `uid` lands. */
  whenAvailable<K extends GeometryPayloadType>(
    uid: Uid,
    kind: K,
    cb: (payload: PayloadOfKind<K>) => void,
  ): void {
    const existing = this.lookup(uid, kind);
    if (existing) {
      cb(existing as PayloadOfKind<K>);
      return;
    }
    const list = this.waiters.get(uid) ?? [];
    list.push({ kind, cb: cb as (p: GeometryPayload) => void });
    this.waiters.set(uid, list);
  }

  /** Insert a freshly-decoded payload and flush any matching waiters. */
  put(payload: GeometryPayload): void {
    switch (payload.kind) {
      case GeometryPayloadType.Node:
        this.nodes.set(payload.uid, payload);
        break;
      case GeometryPayloadType.Mesh:
        this.meshes.set(payload.uid, payload);
        break;
      case GeometryPayloadType.Material:
        this.materials.set(payload.uid, payload);
        break;
      case GeometryPayloadType.Texture:
        this.textures.set(payload.uid, payload);
        break;
      case GeometryPayloadType.Animation:
        this.animations.set(payload.uid, payload);
        break;
      case GeometryPayloadType.Skeleton:
        this.skeletons.set(payload.uid, payload);
        break;
      case GeometryPayloadType.FontAtlas:
        this.fontAtlases.set(payload.uid, payload);
        break;
      case GeometryPayloadType.TextCanvas:
        this.textCanvases.set(payload.uid, payload);
        break;
      case GeometryPayloadType.TexturePointer:
      case GeometryPayloadType.MeshPointer:
        this.pendingPointers.set(payload.uid, {
          uid: payload.uid,
          url: payload.url,
          kind: payload.kind,
          axesStandard: payload.axesStandard,
        });
        // Do not flush waiters here; the body still has to be fetched.
        this.listeners.forEach((l) => l(payload));
        return;
      case GeometryPayloadType.RemoveNodes:
        this.listeners.forEach((l) => l(payload));
        return;
      case "unknown":
        this.listeners.forEach((l) => l(payload));
        return;
    }
    this.flushWaiters(payload);
    this.listeners.forEach((l) => l(payload));
  }

  /** Remove a node (and any waiters for it). Used by RemoveNodes. */
  removeNode(uid: Uid): void {
    this.nodes.delete(uid);
    this.waiters.delete(uid);
  }

  clear(): void {
    this.nodes.clear();
    this.meshes.clear();
    this.materials.clear();
    this.textures.clear();
    this.animations.clear();
    this.skeletons.clear();
    this.fontAtlases.clear();
    this.textCanvases.clear();
    this.pendingPointers.clear();
    this.waiters.clear();
  }

  private flushWaiters(payload: GeometryPayload): void {
    // RemoveNodes carries no single uid (it's a multi-delete) and Unknown is
    // opaque; both are surfaced to listeners only, never matched to waiters.
    if (payload.kind === "unknown") return;
    if (payload.kind === GeometryPayloadType.RemoveNodes) return;
    const uid = payload.uid;
    const list = this.waiters.get(uid);
    if (!list) return;
    const remaining: Waiter[] = [];
    for (const w of list) {
      if (w.kind === payload.kind) {
        w.cb(payload);
      } else {
        remaining.push(w);
      }
    }
    if (remaining.length) this.waiters.set(uid, remaining);
    else this.waiters.delete(uid);
  }

  private lookup(
    uid: Uid,
    kind: GeometryPayloadType,
  ): GeometryPayload | undefined {
    switch (kind) {
      case GeometryPayloadType.Node:
        return this.nodes.get(uid);
      case GeometryPayloadType.Mesh:
        return this.meshes.get(uid);
      case GeometryPayloadType.Material:
        return this.materials.get(uid);
      case GeometryPayloadType.Texture:
        return this.textures.get(uid);
      case GeometryPayloadType.Animation:
        return this.animations.get(uid);
      case GeometryPayloadType.Skeleton:
        return this.skeletons.get(uid);
      case GeometryPayloadType.FontAtlas:
        return this.fontAtlases.get(uid);
      case GeometryPayloadType.TextCanvas:
        return this.textCanvases.get(uid);
      default:
        return undefined;
    }
  }
}
