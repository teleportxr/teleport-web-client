// Skeletal animation playback for streamed avatars.
//
// The server sends one ApplyAnimation per change of locomotion state — not per frame —
// so this holds the last state per node and keeps playing it until told otherwise. A
// state that arrives before the clip or the node it names is kept and retried, because
// nothing will repeat it: a dropped state leaves a body stuck in the wrong animation
// until the user happens to change gait.
//
// Two things are easy to get wrong here and are worth stating plainly:
//
//   * **Clock.** Everything the server timestamps is in session time — microseconds
//     since the setup command's datum — never wall-clock. Feeding a Unix timestamp in
//     puts the playback head decades past the clip.
//   * **Ticking.** Mixers are advanced by an explicit delta computed from that same
//     session clock rather than THREE.Clock, so playback stays in step with the
//     timestamps the states carry.

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Uid } from "../wire/types.js";
import type { ApplyAnimationCommand } from "../wire/commands.js";
import { indexRig, retargetHumanoidClip, type RigIndex } from "./retarget.js";

/** What the server last asked a node to play. */
interface DesiredState {
  animationId: bigint;
  /** Session time, microseconds, at which `animTime` is the position in the clip. */
  timestampUs: bigint;
  animTime: number;
  speed: number;
  loop: boolean;
  /** Cleared once this state has been handed to a mixer. */
  applied: boolean;
}

interface Rig {
  mixer: THREE.AnimationMixer;
  root: THREE.Object3D;
  /** Clips already retargeted onto this rig, by source clip uid. */
  retargeted: Map<bigint, THREE.AnimationClip>;
  /** VRM humanoid role -> this rig's object name, when the avatar is a VRM. */
  humanoidBones?: Record<string, string>;
  /** The rig's bind pose, indexed by role. Captured at mount, before any clip has been
   *  played: once a mixer is writing to the bones, the rest pose is no longer readable. */
  index?: RigIndex;
  current: THREE.AnimationAction | null;
  currentId: bigint;
}

/** A clip and the rig it was authored against. */
interface SourceClip {
  clip: THREE.AnimationClip;
  source: THREE.Object3D;
  /** VRM humanoid role -> node name in `source`, where the file declares it. */
  humanoidBones?: Record<string, string>;
}

export class AnimationController {
  private readonly clips = new Map<bigint, SourceClip>();
  private readonly rigs = new Map<bigint, Rig>();
  private readonly desired = new Map<bigint, DesiredState>();
  private lastSessionTimeUs: bigint | null = null;

  /** Register a clip that arrived as an AnimationPointer, with the rig it was
   *  authored against — retargeting onto an avatar needs both. */
  setClip(
    uid: Uid,
    clip: THREE.AnimationClip,
    source: THREE.Object3D,
    humanoidBones?: Record<string, string>,
  ): void {
    this.clips.set(uid, { clip, source, humanoidBones });
    // A state naming this clip may have arrived first; let it retry.
    for (const st of this.desired.values()) {
      if (st.animationId === uid) st.applied = false;
    }
  }

  hasClip(uid: Uid): boolean {
    return this.clips.has(uid);
  }

  /** Called by the adapter when a node's skinned scene has been mounted. */
  onSkinnedRootMounted(
    nodeId: Uid,
    root: THREE.Object3D,
    humanoidBones?: Record<string, string>,
  ): void {
    const existing = this.rigs.get(nodeId);
    if (existing) existing.mixer.stopAllAction();
    // Indexed now, while the rig is still in its rest pose.
    const byName = humanoidBones
      ? new Map(Object.entries(humanoidBones).map(([role, name]) => [name, role]))
      : null;
    const index = byName
      ? indexRig(root, (o) => (o.name ? byName.get(o.name) : undefined))
      : undefined;
    this.rigs.set(nodeId, {
      mixer: new THREE.AnimationMixer(root),
      root,
      retargeted: new Map(),
      humanoidBones,
      index,
      current: null,
      currentId: 0n,
    });
    // The node's animation state outlives its visual: a re-imported avatar must go
    // straight back to whatever it was doing, and the server will not say again.
    const st = this.desired.get(nodeId);
    if (st) st.applied = false;
  }

  /** Drop everything. The mixers keep their rigs reachable, so this is what lets a
   *  closed session be collected. */
  dispose(): void {
    for (const rig of this.rigs.values()) rig.mixer.stopAllAction();
    this.rigs.clear();
    this.desired.clear();
    this.clips.clear();
    this.lastSessionTimeUs = null;
  }

  /** Drop a node's rig, e.g. when the node is removed. */
  removeNode(nodeId: Uid): void {
    const rig = this.rigs.get(nodeId);
    if (rig) {
      rig.mixer.stopAllAction();
      this.rigs.delete(nodeId);
    }
    this.desired.delete(nodeId);
  }

  /** Record the state the server wants. Only layer 0 is implemented. */
  apply(cmd: ApplyAnimationCommand): void {
    if (cmd.animLayer !== 0) return;
    this.desired.set(cmd.nodeId, {
      animationId: cmd.animationId,
      timestampUs: cmd.timestampUs,
      animTime: cmd.animTimeAtTimestamp,
      speed: cmd.speedUnitsPerSecond,
      loop: cmd.loop,
      applied: false,
    });
  }

  /** Advance every rig. `sessionTimeUs` is microseconds since the setup datum. */
  update(sessionTimeUs: bigint): void {
    for (const [nodeId, st] of this.desired) {
      if (!st.applied) this.tryStart(nodeId, st, sessionTimeUs);
    }
    // First call establishes the baseline; there is no elapsed time to apply yet.
    if (this.lastSessionTimeUs === null) {
      this.lastSessionTimeUs = sessionTimeUs;
      return;
    }
    let deltaS = Number(sessionTimeUs - this.lastSessionTimeUs) / 1e6;
    this.lastSessionTimeUs = sessionTimeUs;
    // A backwards or absurd jump means the session clock was rebased (a reconnect, a
    // device waking); advancing by it would fling every clip somewhere arbitrary.
    if (!(deltaS > 0) || deltaS > 1.0) deltaS = 0;
    for (const rig of this.rigs.values()) rig.mixer.update(deltaS);
  }

  /** Start a pending state, if both its clip and its rig are present yet. */
  private tryStart(nodeId: bigint, st: DesiredState, sessionTimeUs: bigint): void {
    const rig = this.rigs.get(nodeId);
    if (!rig) return;
    const sourceClip = this.clips.get(st.animationId);
    if (!sourceClip) return;

    const retargeted = this.retargetFor(rig, st.animationId, sourceClip);
    if (!retargeted) return;

    const action = rig.mixer.clipAction(retargeted);
    action.enabled = true;
    action.loop = st.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.clampWhenFinished = !st.loop;
    action.timeScale = st.speed;
    action.setEffectiveWeight(1);

    // Where the clip should be *now*. The state names a position at timestampUs, which
    // is usually a little in the future — that lead is the cross-fade — so wind back to
    // where that puts us at this instant.
    const aheadS = Number(st.timestampUs - sessionTimeUs) / 1e6;
    let t = st.animTime - aheadS * st.speed;
    const d = retargeted.duration;
    if (d > 0) {
      t = t % d;
      if (t < 0) t += d;
    } else {
      t = 0;
    }
    action.time = t;

    const previous = rig.current;
    if (previous && previous !== action && rig.currentId !== st.animationId) {
      // Dating a state ahead is what asks for a blend; "now" or in the past snaps.
      const fade = Math.max(0, aheadS);
      action.play();
      if (fade > 0) action.crossFadeFrom(previous, fade, true);
      else previous.stop();
    } else {
      action.play();
    }
    rig.current = action;
    rig.currentId = st.animationId;
    st.applied = true;
  }

  /** A clip authored for one rig will not drive another unless its tracks name that
   *  rig's bones. Where the names already match — as they do between two VRM humanoid
   *  rigs — the clip is used as-is; otherwise it is retargeted once and cached. */
  private retargetFor(
    rig: Rig,
    uid: bigint,
    sourceClip: SourceClip,
  ): THREE.AnimationClip | null {
    const cached = rig.retargeted.get(uid);
    if (cached) return cached;

    let result: THREE.AnimationClip | null = sourceClip.clip;
    if (!this.clipBindsTo(rig.root, sourceClip.clip)) {
      // A VRM animation names its tracks by humanoid role, not by the avatar's bone names,
      // and its rotations are expressed in its own rig's bind frame. Converting between the
      // two frames — not merely renaming — is what keeps the limbs where they belong. This
      // is the live path for .vrma clips: SkeletonUtils cannot help, because a .vrma's scene
      // holds no Bone objects at all for it to read a skeleton from.
      result = this.retargetHumanoid(rig, sourceClip);
      if (!result) {
        try {
          // Two rigs that both have real skeletons but disagree on names: target
          // first, then source. Passing the same rig for both is a no-op.
          result = SkeletonUtils.retargetClip(
            rig.root as never,
            sourceClip.source as never,
            sourceClip.clip,
            {},
          );
        } catch {
          // Best-effort: a clip whose rig cannot be matched is better skipped than
          // allowed to throw every frame from the render loop.
          return null;
        }
      }
    }
    if (!result) return null;
    // Cached per rig: retargeting walks every track and is far too costly per frame.
    rig.retargeted.set(uid, result);
    return result;
  }

  /** Rename a VRM animation's tracks from humanoid roles onto this rig's bone names.
   *
   *  A `.vrma` track is `"<role>.<property>"` — `hips.quaternion`, `leftUpperArm.quaternion`
   *  — while the avatar's bones carry whatever names its author used. The VRM humanoid
   *  extension is the correspondence between them, read out at decode time.
   *
   *  Rotation-only, as VRM animation humanoid tracks are: the quaternions are copied onto
   *  the target bones as-is rather than being converted through each rig's rest pose. That
   *  is right where the two rigs share a rest pose (both T-posed VRM humanoids, as here)
   *  and approximate where they do not. If a clip ever looks twisted rather than merely
   *  wrong-footed, that conversion is the missing piece and `@pixiv/three-vrm`'s
   *  `createVRMAnimationClip` is the tested implementation of it.
   *
   *  Returns null when there is no humanoid map or nothing in the clip matches it. */
  private retargetHumanoid(rig: Rig, sourceClip: SourceClip): THREE.AnimationClip | null {
    if (!rig.index) return null;
    // The clip file's own scene is the source rig. Prefer the role map the file declares;
    // fall back to treating node names as roles, which is all a file that declares nothing
    // gives us to go on.
    const declared = sourceClip.humanoidBones;
    const roleByName = declared
      ? new Map(Object.entries(declared).map(([role, name]) => [name, role]))
      : null;
    const source = indexRig(sourceClip.source, (o) =>
      !o.name ? undefined : roleByName ? roleByName.get(o.name) : o.name,
    );
    if (!source.byRole.size) return null;
    return retargetHumanoidClip(sourceClip.clip, source, rig.index);
  }

  /** Does at least one of the clip's tracks name an object in this rig? */
  private clipBindsTo(root: THREE.Object3D, clip: THREE.AnimationClip): boolean {
    const names = new Set<string>();
    root.traverse((o) => {
      if (o.name) names.add(o.name);
    });
    for (const track of clip.tracks) {
      const dot = track.name.indexOf(".");
      const target = dot >= 0 ? track.name.slice(0, dot) : track.name;
      if (names.has(target)) return true;
    }
    return false;
  }
}
