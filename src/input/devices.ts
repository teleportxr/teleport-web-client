// Device snapshot and the hub that assembles one per frame.
//
// A DeviceSnapshot is a flat view of the canonical control-path tree (paths.ts)
// for a single frame: boolean controls in `buttons`, float controls in `axes`.
// Each input device (desktop, gamepad, …) writes its own raw paths into the
// snapshot; the hub then synthesises the hardware-independent derived
// locomotion axes (/user/move/*, /user/look/*) from whichever source is active.
// Both the control models and the input reporter read the resulting snapshot.

import {
  CROUCH_VALUE,
  JUMP_CLICK,
  LOOK_PITCH,
  LOOK_YAW,
  MOUSE_MOVE_X,
  MOUSE_MOVE_Y,
  MOVE_X,
  MOVE_Y,
  MOVE_Z,
  SPRINT_VALUE,
  gamepadAxis,
  gamepadButtonClick,
  keyboardClick,
} from "./paths.js";

export interface DeviceSnapshot {
  /** Boolean control paths → pressed state. */
  buttons: Map<string, boolean>;
  /** Float control paths → value. Per-frame deltas (look, wheel) included. */
  axes: Map<string, number>;
}

export function emptySnapshot(): DeviceSnapshot {
  return { buttons: new Map(), axes: new Map() };
}

export function snapshotButton(s: DeviceSnapshot, path: string): boolean {
  return s.buttons.get(path) ?? false;
}

export function snapshotAxis(s: DeviceSnapshot, path: string): number {
  return s.axes.get(path) ?? 0;
}

/** A source of raw control values. `read` writes this device's own canonical
 *  paths into the shared snapshot; the hub calls it once per frame. */
export interface InputDevice {
  read(out: DeviceSnapshot): void;
  dispose?(): void;
}

/** Deadzone applied to analogue sticks before they reach the derived axes. */
const STICK_DEADZONE = 0.15;

function deadzone(v: number): number {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}

/** Owns the set of input devices and produces a merged, derived snapshot.
 *  Device readers are pure with respect to the snapshot; all cross-device
 *  abstraction (WASD or stick → /user/move/*) lives here so the two consumers
 *  — control models and the input reporter — see one consistent intent. */
export class DeviceHub {
  private devices: InputDevice[] = [];

  add(device: InputDevice): this {
    this.devices.push(device);
    return this;
  }

  sample(): DeviceSnapshot {
    const snap = emptySnapshot();
    for (const d of this.devices) d.read(snap);
    this.deriveLocomotion(snap);
    return snap;
  }

  dispose(): void {
    for (const d of this.devices) d.dispose?.();
    this.devices = [];
  }

  /** Fold raw keyboard / gamepad controls into the hardware-independent
   *  locomotion axes. Keyboard takes precedence when any WASD key is held,
   *  otherwise the gamepad's left stick drives movement; look combines mouse
   *  delta (already in the snapshot) with the right stick. */
  private deriveLocomotion(snap: DeviceSnapshot): void {
    const held = (code: string) => snapshotButton(snap, keyboardClick(code));
    let mx = (held("KeyD") ? 1 : 0) - (held("KeyA") ? 1 : 0);
    let my = (held("KeyW") ? 1 : 0) - (held("KeyS") ? 1 : 0);
    let mz = (held("KeyE") ? 1 : 0) - (held("KeyQ") ? 1 : 0);

    if (mx === 0 && my === 0) {
      // Pad 0 left stick: axis 0 = X (right +), axis 1 = Y (down +).
      const sx = deadzone(snapshotAxis(snap, gamepadAxis(0, 0)));
      const sy = deadzone(snapshotAxis(snap, gamepadAxis(0, 1)));
      mx = sx;
      my = -sy;
    }
    snap.axes.set(MOVE_X, mx);
    snap.axes.set(MOVE_Y, my);
    snap.axes.set(MOVE_Z, mz);

    // Look: mouse delta (set by the desktop device) plus right stick. The
    // right stick is a rate, scaled to a per-frame-ish delta by the model.
    const lookYaw = snapshotAxis(snap, MOUSE_MOVE_X) +
      deadzone(snapshotAxis(snap, gamepadAxis(0, 2))) * RIGHT_STICK_LOOK;
    const lookPitch = snapshotAxis(snap, MOUSE_MOVE_Y) +
      deadzone(snapshotAxis(snap, gamepadAxis(0, 3))) * RIGHT_STICK_LOOK;
    snap.axes.set(LOOK_YAW, lookYaw);
    snap.axes.set(LOOK_PITCH, lookPitch);

    // Standard gamepad face/shoulder mappings for common locomotion actions.
    if (snapshotButton(snap, gamepadButtonClick(0, 0))) snap.buttons.set(JUMP_CLICK, true);
    if (snapshotButton(snap, gamepadButtonClick(0, 10))) snap.axes.set(SPRINT_VALUE, 1);
    if (snapshotButton(snap, gamepadButtonClick(0, 1))) snap.axes.set(CROUCH_VALUE, 1);
  }
}

/** Pixels-equivalent look contribution of a fully-deflected right stick, so
 *  pad and mouse look share the model's single sensitivity constant. */
const RIGHT_STICK_LOOK = 12;
