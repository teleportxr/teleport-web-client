// Retarget a VRM humanoid animation from the rig it was authored on onto an avatar's rig.
//
// A port of the C++ client's ClientRender/AnimationRetargeter.cpp, adapted from that code's
// Engineering space (z up) to glTF's y-up. Keep the two in step: they are the same algorithm
// and are expected to produce the same pose.
//
// Why this is needed at all, rather than copying the clip's rotations onto the matching bones:
// a joint's local rotation only means anything relative to its own rig's bind pose. A VRM
// animation is authored on a *normalised* rig — identity rotations throughout, facing encoded
// purely in the bind translations — while an avatar's skeleton carries whatever bind rotations
// its author baked in. Copying one onto the other applies each rotation in the wrong frame,
// which is what puts legs through the torso and arms out at the wrong angle.
//
// The conversion, for a target joint T whose source counterpart is S:
//
//     qT(t) = conj(bindModel(parent(T)).q) · align · bindModel(anchor(S)).q
//             · [folded source locals] · qS(t)
//             · conj(bindModel(S).q) · conj(align) · bindModel(T).q
//
// where bindModel is a joint's model-space bind transform, anchor(S) is the nearest source
// ancestor that also exists in the target, and `align` is the yaw that squares the two rigs'
// facings. The leading terms carry the source's animated local rotation into the target
// parent's frame; the trailing terms take it from the source's bind frame into the target's.

import * as THREE from "three";

/** One joint of a rig, in the form the retarget maths needs. */
interface Joint {
  object: THREE.Object3D;
  /** Local bind (rest) transform: the pose before any animation is applied. */
  bindLocal: THREE.Quaternion;
  /** Model-space bind transform, relative to the rig root. */
  bindModelPos: THREE.Vector3;
  bindModelQuat: THREE.Quaternion;
  bindModelScale: THREE.Vector3;
}

/** A rig indexed by VRM humanoid role, plus the bind pose of every object in it. */
export interface RigIndex {
  root: THREE.Object3D;
  /** role -> joint. Only roles the rig actually fills. */
  byRole: Map<string, Joint>;
  /** Every object's model-space bind transform, including objects with no role: a target
   *  joint's parent frame is its *actual* parent, which may be an unroled group. */
  bindByObject: Map<THREE.Object3D, Joint>;
}

/** Index a rig's current pose as its bind pose.
 *
 *  Call this before any clip has been played: `Object3D.matrixWorld` is the rest pose only
 *  until a mixer starts writing to it.
 *
 *  `roleOf` maps an object to its humanoid role. For an avatar that comes from the VRM
 *  humanoid extension; for a VRM animation the node names *are* the roles. */
export function indexRig(
  root: THREE.Object3D,
  roleOf: (object: THREE.Object3D) => string | undefined,
): RigIndex {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const byRole = new Map<string, Joint>();
  const bindByObject = new Map<THREE.Object3D, Joint>();
  root.traverse((object) => {
    // Model space here means "relative to the rig root", so that two rigs sitting at
    // different places in their scenes still compare like for like.
    const model = new THREE.Matrix4().multiplyMatrices(rootInverse, object.matrixWorld);
    const bindModelPos = new THREE.Vector3();
    const bindModelQuat = new THREE.Quaternion();
    const bindModelScale = new THREE.Vector3();
    model.decompose(bindModelPos, bindModelQuat, bindModelScale);

    const joint: Joint = {
      object,
      bindLocal: object.quaternion.clone(),
      bindModelPos,
      bindModelQuat,
      bindModelScale,
    };
    bindByObject.set(object, joint);
    const role = roleOf(object);
    if (role && !byRole.has(role)) byRole.set(role, joint);
  });
  return { root, byRole, bindByObject };
}

/** Yaw aligning the source rig's bind facing with the target's.
 *
 *  Facing cannot be read from bind rotations, because a normalised rig has identity
 *  rotations everywhere and encodes its facing purely in the bind translations. So it is
 *  derived from the lateral axis of paired limbs instead. glTF is y-up, so the horizontal
 *  plane is xz and the yaw is about y. */
function computeAlignmentRotation(src: RigIndex, tgt: RigIndex): THREE.Quaternion {
  const lateralPairs: [string, string][] = [
    ["leftUpperLeg", "rightUpperLeg"],
    ["leftUpperArm", "rightUpperArm"],
    ["leftShoulder", "rightShoulder"],
    ["leftHand", "rightHand"],
  ];
  for (const [leftRole, rightRole] of lateralPairs) {
    const sl = src.byRole.get(leftRole);
    const sr = src.byRole.get(rightRole);
    const tl = tgt.byRole.get(leftRole);
    const tr = tgt.byRole.get(rightRole);
    if (!sl || !sr || !tl || !tr) continue;

    const sx = sr.bindModelPos.x - sl.bindModelPos.x;
    const sz = sr.bindModelPos.z - sl.bindModelPos.z;
    const tx = tr.bindModelPos.x - tl.bindModelPos.x;
    const tz = tr.bindModelPos.z - tl.bindModelPos.z;
    if (Math.hypot(sx, sz) < 1e-5 || Math.hypot(tx, tz) < 1e-5) continue;

    // Signed angle from the source's lateral axis to the target's, about +y.
    const dot = sx * tx + sz * tz;
    const cross = sz * tx - sx * tz;
    const yaw = Math.atan2(cross, dot);
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }
  return new THREE.Quaternion();
}

/** Nearest ancestor of `object` that carries a role present in `src`. */
function findAnchorRole(
  object: THREE.Object3D,
  tgt: RigIndex,
  src: RigIndex,
): string | null {
  const roleByObject = new Map<THREE.Object3D, string>();
  for (const [role, joint] of tgt.byRole) roleByObject.set(joint.object, role);
  for (let p = object.parent; p; p = p.parent) {
    const role = roleByObject.get(p);
    if (role && src.byRole.has(role)) return role;
  }
  return null;
}

/** Source roles strictly between `anchorRole` and `role`, nearest-ancestor last.
 *
 *  These exist in the source but not the target, so their animated rotation would simply be
 *  lost. Folding them into the child that does exist keeps the limb's overall orientation
 *  right. Returns null when the anchor is not actually an ancestor of `role` in the source,
 *  which means the two hierarchies disagree and the joint is better left in its bind pose. */
function foldedRoles(
  src: RigIndex,
  role: string,
  anchorRole: string | null,
  roleOfSourceObject: Map<THREE.Object3D, string>,
): string[] | null {
  const joint = src.byRole.get(role);
  if (!joint) return null;
  const anchorObject = anchorRole ? src.byRole.get(anchorRole)?.object : undefined;
  const folded: string[] = [];
  for (let p = joint.object.parent; ; p = p.parent) {
    if (!p) return anchorObject ? null : folded.reverse();
    if (p === anchorObject) return folded.reverse();
    const r = roleOfSourceObject.get(p);
    if (r) folded.push(r);
  }
}

/** Sample a quaternion track at `time`, shortest-path, matching three's own interpolation. */
function sampleQuaternion(
  track: THREE.QuaternionKeyframeTrack | undefined,
  time: number,
  fallback: THREE.Quaternion,
): THREE.Quaternion {
  if (!track || track.times.length === 0) return fallback.clone();
  const times = track.times;
  const v = track.values;
  const at = (i: number) =>
    new THREE.Quaternion(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]);
  if (time <= times[0]) return at(0);
  if (time >= times[times.length - 1]) return at(times.length - 1);
  let next = 1;
  while (times[next] < time) next++;
  const t0 = times[next - 1];
  const t1 = times[next];
  const alpha = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  const a = at(next - 1);
  const b = at(next);
  if (a.dot(b) < 0) b.set(-b.x, -b.y, -b.z, -b.w);
  return a.slerp(b, alpha);
}

export interface RetargetOptions {
  /** Role of the joint whose translation carries the body's motion. */
  rootMotionRole?: string;
}

/** Retarget `clip`, authored on `src`, onto `tgt`.
 *
 *  Tracks are emitted against the target objects' names, so the result binds directly to a
 *  mixer rooted at the target rig. Target joints the source does not animate get no track and
 *  so keep their rest pose. Returns null if nothing could be mapped. */
export function retargetHumanoidClip(
  clip: THREE.AnimationClip,
  src: RigIndex,
  tgt: RigIndex,
  options: RetargetOptions = {},
): THREE.AnimationClip | null {
  const rootMotionRole = options.rootMotionRole ?? "hips";
  const align = computeAlignmentRotation(src, tgt);
  const alignConj = align.clone().conjugate();

  const roleOfSourceObject = new Map<THREE.Object3D, string>();
  for (const [role, joint] of src.byRole) roleOfSourceObject.set(joint.object, role);

  // Source tracks indexed by role. A track is named for the *node* it drives, which is not
  // required to be the role name — so it is resolved through the source index, which was
  // built from whatever mapping the file declared.
  const roleByObjectName = new Map<string, string>();
  for (const [role, joint] of src.byRole) {
    if (joint.object.name) roleByObjectName.set(joint.object.name, role);
  }
  const rotationByRole = new Map<string, THREE.QuaternionKeyframeTrack>();
  const positionByRole = new Map<string, THREE.VectorKeyframeTrack>();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    if (dot < 0) continue;
    const role = roleByObjectName.get(track.name.slice(0, dot));
    if (!role) continue;
    const property = track.name.slice(dot + 1);
    if (property === "quaternion") {
      rotationByRole.set(role, track as THREE.QuaternionKeyframeTrack);
    } else if (property === "position") {
      positionByRole.set(role, track as THREE.VectorKeyframeTrack);
    }
  }

  const out: THREE.KeyframeTrack[] = [];
  for (const [role, tgtJoint] of tgt.byRole) {
    const srcJoint = src.byRole.get(role);
    if (!srcJoint) continue;
    const sourceTrack = rotationByRole.get(role);
    const anchorRole = findAnchorRole(tgtJoint.object, tgt, src);
    const folded = foldedRoles(src, role, anchorRole, roleOfSourceObject);
    if (folded === null) continue;
    if (!sourceTrack && folded.length === 0) continue;

    const parentJoint = tgtJoint.object.parent
      ? tgt.bindByObject.get(tgtJoint.object.parent)
      : undefined;
    const targetParentQuat = parentJoint
      ? parentJoint.bindModelQuat
      : new THREE.Quaternion();
    const anchorQuat = anchorRole
      ? src.byRole.get(anchorRole)!.bindModelQuat
      : new THREE.Quaternion();

    // pre  takes the source's animated local rotation into the target parent's frame
    // post takes it out of the source's bind frame and into the target's
    const pre = targetParentQuat.clone().conjugate().multiply(align).multiply(anchorQuat);
    const post = srcJoint.bindModelQuat
      .clone()
      .conjugate()
      .multiply(alignConj)
      .multiply(tgtJoint.bindModelQuat);

    // Key at the union of the primary and folded tracks' times, so an animated folded joint
    // is not undersampled at the primary track's key times.
    const timeSet = new Set<number>();
    for (const t of sourceTrack?.times ?? []) timeSet.add(t);
    for (const f of folded) for (const t of rotationByRole.get(f)?.times ?? []) timeSet.add(t);
    if (timeSet.size === 0) continue;
    const times = [...timeSet].sort((a, b) => a - b);

    const values = new Float32Array(times.length * 4);
    for (let i = 0; i < times.length; i++) {
      const q = pre.clone();
      for (const f of folded) {
        const fj = src.byRole.get(f)!;
        q.multiply(sampleQuaternion(rotationByRole.get(f), times[i], fj.bindLocal));
      }
      q.multiply(sampleQuaternion(sourceTrack, times[i], srcJoint.bindLocal));
      q.multiply(post).normalize();
      values.set([q.x, q.y, q.z, q.w], i * 4);
    }
    out.push(
      new THREE.QuaternionKeyframeTrack(
        `${tgtJoint.object.name}.quaternion`,
        Array.from(times),
        Array.from(values),
      ),
    );

    // Only the root joint inherits the source's translation, scaled by the rigs' relative
    // height; every other joint keeps its own bind translation so the avatar's proportions
    // are its own rather than the animation's.
    const sourcePos = positionByRole.get(role);
    if (role === rootMotionRole && sourcePos) {
      const srcParent = srcJoint.object.parent
        ? src.bindByObject.get(srcJoint.object.parent)
        : undefined;
      const heightScale = computeHeightScale(srcJoint, tgtJoint);
      const targetParent = parentJoint;
      const posValues = new Float32Array(sourcePos.times.length * 3);
      for (let i = 0; i < sourcePos.times.length; i++) {
        const local = new THREE.Vector3(
          sourcePos.values[i * 3],
          sourcePos.values[i * 3 + 1],
          sourcePos.values[i * 3 + 2],
        );
        // Source local -> source model, through the parent's bind transform.
        const sourceModel = srcParent
          ? local
              .clone()
              .multiply(srcParent.bindModelScale)
              .applyQuaternion(srcParent.bindModelQuat)
              .add(srcParent.bindModelPos)
          : local.clone();
        const delta = sourceModel
          .sub(srcJoint.bindModelPos)
          .applyQuaternion(align)
          .multiplyScalar(heightScale);
        const targetModel = tgtJoint.bindModelPos.clone().add(delta);
        // Target model -> target local, through the target parent's bind transform.
        const offset = targetParent
          ? targetModel
              .sub(targetParent.bindModelPos)
              .applyQuaternion(targetParent.bindModelQuat.clone().conjugate())
              .divide(safeScale(targetParent.bindModelScale))
          : targetModel;
        posValues.set([offset.x, offset.y, offset.z], i * 3);
      }
      out.push(
        new THREE.VectorKeyframeTrack(
          `${tgtJoint.object.name}.position`,
          Array.from(sourcePos.times),
          Array.from(posValues),
        ),
      );
    }
  }

  if (!out.length) return null;
  return new THREE.AnimationClip(`${clip.name}_retargeted`, clip.duration, out);
}

/** Ratio of the two rigs' heights at this joint. y is up in glTF. */
function computeHeightScale(src: Joint, tgt: Joint): number {
  if (Math.abs(src.bindModelPos.y) > 1e-5) {
    return tgt.bindModelPos.y / src.bindModelPos.y;
  }
  const sl = src.bindModelPos.length();
  const tl = tgt.bindModelPos.length();
  return sl > 1e-5 ? tl / sl : 1;
}

function safeScale(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x || 1, v.y || 1, v.z || 1);
}
