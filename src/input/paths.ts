// The web client's canonical control-path tree.
//
// The protocol's input model (Teleport/docs/protocol/input.rst) is regex-based:
// the server's SetupInputsCommand declares each input with a regex that the
// client matches against the canonical paths its hardware exposes. OpenXR
// clients expose paths like "/user/hand/left/input/trigger/value"; non-OpenXR
// clients are expected to expose "an analogous canonical path tree". This file
// is the web client's tree — the contract `report.ts` resolves regexes against,
// and the namespace the control models read for locomotion.
//
// Two families of path live here:
//   * raw device paths — one physical control each (a key, a mouse button…);
//   * derived locomotion axes — hardware-independent abstractions the device
//     hub synthesises identically whether the source is WASD or a gamepad
//     stick (see the design plan, plans/web_client_input_and_control.md).

/** Raw keyboard control. `code` is a KeyboardEvent.code, e.g. "KeyW". */
export const keyboardClick = (code: string): string => `/user/keyboard/${code}/click`;
export const keyboardValue = (code: string): string => `/user/keyboard/${code}/value`;

/** Raw mouse buttons and motion (motion is delta, only meaningful when the
 *  pointer is locked). */
export const mouseClick = (button: "left" | "right" | "middle"): string =>
  `/user/mouse/${button}/click`;
export const MOUSE_MOVE_X = "/user/mouse/move/x";
export const MOUSE_MOVE_Y = "/user/mouse/move/y";
export const MOUSE_WHEEL_Y = "/user/mouse/wheel/y";

/** Raw gamepad controls. `i` is the pad index, `n` the button / axis index. */
export const gamepadButtonClick = (i: number, n: number): string =>
  `/user/gamepad/${i}/button/${n}/click`;
export const gamepadButtonValue = (i: number, n: number): string =>
  `/user/gamepad/${i}/button/${n}/value`;
export const gamepadAxis = (i: number, n: number): string =>
  `/user/gamepad/${i}/axis/${n}`;

// Derived locomotion axes — the load-bearing abstraction. Both the local
// control models and the server-declared input bindings read these, so the
// device→intent mapping is written once and consumed two ways.
export const MOVE_X = "/user/move/x"; // strafe, −1 (left) … +1 (right)
export const MOVE_Y = "/user/move/y"; // forward, −1 (back) … +1 (forward)
export const MOVE_Z = "/user/move/z"; // vertical, −1 (down) … +1 (up)
export const LOOK_YAW = "/user/look/yaw"; // per-frame yaw delta (turn)
export const LOOK_PITCH = "/user/look/pitch"; // per-frame pitch delta (tilt)
export const JUMP_CLICK = "/user/locomotion/jump/click";
export const SPRINT_VALUE = "/user/locomotion/sprint/value";
export const CROUCH_VALUE = "/user/locomotion/crouch/value";
