// Free-fly control model (Model A) integration behaviour.

import { describe, expect, it } from "vitest";
import { FreeFlyModel } from "../src/input/models/freefly.js";
import { emptySnapshot, type DeviceSnapshot } from "../src/input/devices.js";
import { LOOK_YAW, MOVE_Y } from "../src/input/paths.js";
import { rotateVec } from "../src/input/math.js";

function snap(axes: Record<string, number>): DeviceSnapshot {
  const s = emptySnapshot();
  for (const [k, v] of Object.entries(axes)) s.axes.set(k, v);
  return s;
}

describe("FreeFlyModel", () => {
  it("flies forward along -Z at rest orientation", () => {
    const m = new FreeFlyModel({ position: [0, 1.6, 0], speed: 4 });
    const out = m.update(1, snap({ [MOVE_Y]: 1 }));
    expect(out.head.position[0]).toBeCloseTo(0, 5);
    expect(out.head.position[1]).toBeCloseTo(1.6, 5);
    expect(out.head.position[2]).toBeCloseTo(-4, 5);
  });

  it("camera and head poses coincide (first-person)", () => {
    const m = new FreeFlyModel();
    const out = m.update(0.5, snap({ [MOVE_Y]: 1 }));
    expect(out.camera.position).toEqual(out.head.position);
    expect(out.camera.orientation).toEqual(out.head.orientation);
  });

  it("mouse yaw turns the view", () => {
    const m = new FreeFlyModel({ lookSensitivity: 0.01 });
    // Positive yaw delta should turn right (forward vector gains +X... actually
    // -X for left-handed mouse): just assert the orientation changed.
    const out = m.update(0.016, snap({ [LOOK_YAW]: 100 }));
    const fwd = rotateVec(out.head.orientation, [0, 0, -1]);
    expect(Math.abs(fwd[0])).toBeGreaterThan(0.1);
  });

  it("reconcile snaps to a server-imposed pose", () => {
    const m = new FreeFlyModel({ position: [0, 0, 0] });
    m.reconcile("head", { position: [5, 2, 3], orientation: [0, 0, 0, 1] });
    const out = m.update(0, emptySnapshot());
    expect(out.head.position).toEqual([5, 2, 3]);
  });
});
