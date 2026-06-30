// Model A — first-person free-fly (full 6-DOF).
//
// The "camera is the viewpoint" case: mouse-look drives yaw and pitch, WASD
// translates in the look frame, Q/E (or the derived vertical axis) move along
// world up/down, the wheel adjusts speed. The controlled head node pose equals
// the camera pose, so the server receives a freely-moving head exactly as it
// would from an XR user who flew there. No gravity or collision — that is
// Model B's concern.
//
// This model is pure data: it reads a DeviceSnapshot's derived locomotion axes
// and emits poses. The Web Component copies `camera` onto its THREE camera and
// streams `head` via ControllerPoses.

import {
  LOOK_PITCH,
  LOOK_YAW,
  MOVE_X,
  MOVE_Y,
  MOVE_Z,
  MOUSE_WHEEL_Y,
} from "../paths.js";
import { snapshotAxis, type DeviceSnapshot } from "../devices.js";
import {
  clamp,
  quatFromYawPitch,
  rotateVec,
  vecAdd,
  vecScale,
  type Quat,
  type Vec3,
} from "../math.js";
import type { ControlModel, ControlOutput, Pose } from "../control_model.js";

export interface FreeFlyOptions {
  /** Starting eye position in stage space. */
  position?: Vec3;
  /** Starting yaw (radians, about world Y). */
  yaw?: number;
  /** Starting pitch (radians, about local X). */
  pitch?: number;
  /** Base movement speed, metres/second. */
  speed?: number;
  /** Radians of look per pixel of pointer-lock motion. */
  lookSensitivity?: number;
}

// Just under 90° so the view never flips through vertical.
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MIN_SPEED = 0.25;
const MAX_SPEED = 64;

export class FreeFlyModel implements ControlModel {
  private position: Vec3;
  private yaw: number;
  private pitch: number;
  private speed: number;
  private readonly lookSensitivity: number;
  private prevPosition: Vec3;

  constructor(opts: FreeFlyOptions = {}) {
    this.position = opts.position ? [...opts.position] : [0, 1.6, 0];
    this.prevPosition = [...this.position];
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? 0;
    this.speed = opts.speed ?? 4;
    this.lookSensitivity = opts.lookSensitivity ?? 0.0025;
  }

  update(dt: number, devices: DeviceSnapshot): ControlOutput {
    // Look. Mouse-right / pad-right yields a positive yaw delta, which should
    // turn the view to the right — a negative rotation about world Y in a
    // right-handed, Y-up frame. Pitch is likewise inverted so moving the mouse
    // up looks up.
    this.yaw -= snapshotAxis(devices, LOOK_YAW) * this.lookSensitivity;
    this.pitch = clamp(
      this.pitch - snapshotAxis(devices, LOOK_PITCH) * this.lookSensitivity,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    const orientation: Quat = quatFromYawPitch(this.yaw, this.pitch);

    // Speed adjustment from the wheel: each notch scales by ~10%.
    const wheel = snapshotAxis(devices, MOUSE_WHEEL_Y);
    if (wheel !== 0) {
      this.speed = clamp(this.speed * Math.pow(0.9, wheel / 100), MIN_SPEED, MAX_SPEED);
    }

    // Translate in the look frame: forward follows the full orientation (so you
    // fly where you look), strafe is the local right, vertical is world up.
    const forward = rotateVec(orientation, [0, 0, -1]);
    const right = rotateVec(orientation, [1, 0, 0]);
    const worldUp: Vec3 = [0, 1, 0];
    let move: Vec3 = [0, 0, 0];
    move = vecAdd(move, vecScale(right, snapshotAxis(devices, MOVE_X)));
    move = vecAdd(move, vecScale(forward, snapshotAxis(devices, MOVE_Y)));
    move = vecAdd(move, vecScale(worldUp, snapshotAxis(devices, MOVE_Z)));

    this.prevPosition = [...this.position];
    this.position = vecAdd(this.position, vecScale(move, this.speed * dt));

    const head: Pose = { position: [...this.position], orientation };
    const velocity: Vec3 = dt > 0
      ? vecScale(
          [
            this.position[0] - this.prevPosition[0],
            this.position[1] - this.prevPosition[1],
            this.position[2] - this.prevPosition[2],
          ],
          1 / dt,
        )
      : [0, 0, 0];

    return {
      camera: { position: [...this.position], orientation },
      head,
      // Free-fly drives only the head; no separate avatar-root node.
      ownedPoses: new Map([
        ["head", { ...head, velocity, angularVelocity: [0, 0, 0] }],
      ]),
    };
  }

  reconcile(path: string, pose: Pose): void {
    // The server's final say (e.g. SetOriginNode): snap to the imposed pose and
    // re-derive yaw/pitch so subsequent look input continues from there.
    if (path !== "head") return;
    this.position = [...pose.position];
    this.prevPosition = [...pose.position];
    const [yaw, pitch] = yawPitchFromQuat(pose.orientation);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Current speed, exposed for a HUD / debugging. */
  get currentSpeed(): number {
    return this.speed;
  }
}

/** Recover (yaw, pitch) from an orientation built by quatFromYawPitch. */
function yawPitchFromQuat(q: Quat): [number, number] {
  // Forward = R * (0,0,-1). yaw = atan2(-fx, -fz); pitch = asin(fy).
  const f = rotateVec(q, [0, 0, -1]);
  const yaw = Math.atan2(-f[0], -f[2]);
  const pitch = Math.asin(clamp(f[1], -1, 1));
  return [yaw, pitch];
}
