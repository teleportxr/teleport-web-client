// Control-model interface: the swappable local mapping from raw devices to
// the poses of the nodes this client controls, plus the local camera.
//
// A control model is the embodiment of one locomotion / viewpoint use-case
// (free-fly, avatar-constrained, third-person — see the design plan). It reads
// a per-frame DeviceSnapshot and produces (a) poses for owned nodes and (b) a
// camera transform. Crucially it never touches the wire format: the Web
// Component decides which owned poses to stream and how, and copies the camera
// transform onto its renderer. Swapping models therefore changes only local
// behaviour, never the protocol.

import type { Quat, Vec3 } from "./math.js";
import type { DeviceSnapshot } from "./devices.js";

/** A rigid pose. Orientation is a unit quaternion (x, y, z, w). */
export interface Pose {
  position: Vec3;
  orientation: Quat;
}

/** A pose with first derivatives, as carried by ControllerPoses node poses. */
export interface PoseDynamic extends Pose {
  velocity: Vec3;
  angularVelocity: Vec3;
}

/** Output of a control-model update for one frame. */
export interface ControlOutput {
  /** Camera transform the renderer should adopt this frame. */
  camera: Pose;
  /** Head pose to stream as the ControllerPoses headPose (origin/stage space).
   *  For first-person models this equals the camera; third-person decouples
   *  them. */
  head: Pose;
  /** Owned named-node poses keyed by canonical pose path (e.g.
   *  "/user/avatar/root/pose"). Empty for models that drive only the head.
   *  The component resolves these paths to node uids via AssignNodePosePath. */
  ownedPoses: Map<string, PoseDynamic>;
}

export interface ControlModel {
  /** Advance the model by `dt` seconds given the latest device snapshot. */
  update(dt: number, devices: DeviceSnapshot): ControlOutput;
  /** Accept a server-imposed correction for an owned pose path (or the head,
   *  key "head"), blending local state toward it. This is the client honouring
   *  the server's final say over the simulation; see SetOriginNode handling. */
  reconcile(path: string, pose: Pose): void;
}
