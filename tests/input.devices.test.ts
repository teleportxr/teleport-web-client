// DeviceHub locomotion-axis derivation from raw devices.

import { describe, expect, it } from "vitest";
import {
  DeviceHub,
  snapshotAxis,
  type DeviceSnapshot,
  type InputDevice,
} from "../src/input/devices.js";
import { MOVE_X, MOVE_Y, gamepadAxis, keyboardClick } from "../src/input/paths.js";

function fakeDevice(write: (s: DeviceSnapshot) => void): InputDevice {
  return { read: write };
}

describe("DeviceHub.deriveLocomotion", () => {
  it("maps WASD to the move axes", () => {
    const hub = new DeviceHub().add(
      fakeDevice((s) => {
        s.buttons.set(keyboardClick("KeyW"), true);
        s.buttons.set(keyboardClick("KeyD"), true);
      }),
    );
    const snap = hub.sample();
    expect(snapshotAxis(snap, MOVE_Y)).toBe(1);
    expect(snapshotAxis(snap, MOVE_X)).toBe(1);
  });

  it("falls back to the left stick when no WASD key is held", () => {
    const hub = new DeviceHub().add(
      fakeDevice((s) => {
        s.axes.set(gamepadAxis(0, 0), 0.8); // X right
        s.axes.set(gamepadAxis(0, 1), -1); // Y up (stick up is negative)
      }),
    );
    const snap = hub.sample();
    expect(snapshotAxis(snap, MOVE_X)).toBeCloseTo(0.8);
    expect(snapshotAxis(snap, MOVE_Y)).toBeCloseTo(1);
  });

  it("applies a stick deadzone", () => {
    const hub = new DeviceHub().add(
      fakeDevice((s) => s.axes.set(gamepadAxis(0, 0), 0.05)),
    );
    expect(snapshotAxis(hub.sample(), MOVE_X)).toBe(0);
  });
});
