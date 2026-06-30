// Minimal quaternion / vector helpers for the input layer.
//
// The input modules are deliberately free of any Three.js dependency so they
// can be unit-tested as plain data transforms; the Web Component is the only
// place THREE and the input poses meet. These helpers cover just what the
// control models need: building an orientation from yaw/pitch and rotating a
// direction vector by it. All quaternions are (x, y, z, w), matching the wire
// format (vec4 orientation) and Three.js's own component order. The coordinate
// convention is GL-style — right-handed, Y up, forward = -Z — which is the
// AxesStandard the client declares in its Handshake.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Hamilton product a * b. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Quaternion for a rotation of `angle` radians about a unit axis. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** FPS-style orientation: yaw about world Y, then pitch about local X.
 *  Equivalent to Ry(yaw) * Rx(pitch); roll is rarely wanted so it is optional. */
export function quatFromYawPitch(yaw: number, pitch: number, roll = 0): Quat {
  const qy = quatFromAxisAngle([0, 1, 0], yaw);
  const qx = quatFromAxisAngle([1, 0, 0], pitch);
  const q = quatMul(qy, qx);
  if (roll === 0) return q;
  return quatMul(q, quatFromAxisAngle([0, 0, 1], roll));
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Rotate vector `v` by unit quaternion `q` (v' = q * v * q⁻¹). */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const qv: Vec3 = [q[0], q[1], q[2]];
  const t = cross(qv, v).map((c) => c * 2) as Vec3;
  const qt = cross(qv, t);
  return [
    v[0] + q[3] * t[0] + qt[0],
    v[1] + q[3] * t[1] + qt[1],
    v[2] + q[3] * t[2] + qt[2],
  ];
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vecLength(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Clamp `v` to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
