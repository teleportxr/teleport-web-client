// Quaternion / vector helpers used by the control models.

import { describe, expect, it } from "vitest";
import {
  quatFromYawPitch,
  rotateVec,
  vecLength,
} from "../src/input/math.js";

const close = (a: number[], b: number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]) < eps);

describe("input math", () => {
  it("identity orientation looks down -Z", () => {
    const f = rotateVec(quatFromYawPitch(0, 0), [0, 0, -1]);
    expect(close(f, [0, 0, -1])).toBe(true);
  });

  it("yaw of +90° about Y points the forward vector to -X", () => {
    const f = rotateVec(quatFromYawPitch(Math.PI / 2, 0), [0, 0, -1]);
    expect(close(f, [-1, 0, 0])).toBe(true);
  });

  it("pitch of +45° raises the forward vector", () => {
    const f = rotateVec(quatFromYawPitch(0, Math.PI / 4), [0, 0, -1]);
    expect(f[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(vecLength(f)).toBeCloseTo(1, 6);
  });
});
