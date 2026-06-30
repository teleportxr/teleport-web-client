# src/input — local input & control layer

Turns the browser's raw devices into the two things the Teleport protocol
carries: **node poses** (`ControllerPoses`) and **abstract input values**
(`InputStates` / `InputEvents`). Design rationale and the protocol-impact
analysis live in `plans/web_client_input_and_control.md` (workspace root).

The layer is deliberately free of any Three.js dependency so it can be
unit-tested as plain data transforms; `src/component.ts` is the only place the
poses meet THREE.

## Files

| File | Role |
|------|------|
| `paths.ts` | The canonical control-path tree the regexes in `SetupInputs` match against (the web-client analogue of OpenXR component paths), plus the derived locomotion axes (`/user/move/*`, `/user/look/*`). |
| `math.ts` | Minimal quaternion / vector helpers (GL-style: right-handed, Y up, forward −Z). |
| `devices.ts` | `DeviceSnapshot` type and `DeviceHub`, which merges device readers per frame and synthesises the derived locomotion axes. |
| `desktop.ts` | `DesktopInput`: keyboard, mouse buttons, Pointer-Lock mouse motion, wheel. |
| `gamepad.ts` | `GamepadInput`: polls the Gamepad API. |
| `control_model.ts` | `ControlModel` interface + `Pose` / `PoseDynamic` / `ControlOutput` types. A control model maps a snapshot to owned-node poses + a camera transform, and never touches the wire. |
| `models/freefly.ts` | Model A — first-person free-fly (6-DOF); head pose = camera. |
| `report.ts` | `InputReporter`: resolves `SetupInputs` regexes against the advertised canonical controls and builds the per-frame state/event messages. Abstract actions only — locomotion is consumed by control models, not reported here. |
| `bind.ts` | Legacy regex→binding stub kept for compatibility; superseded by `report.ts`. |

## How it flows (per frame, in `component.ts`)

1. `DeviceHub.sample()` → a `DeviceSnapshot`.
2. The active `ControlModel.update(dt, snap)` → camera pose (copied onto the
   THREE camera) + head pose (streamed via `buildControllerPoses`).
3. `InputReporter.report(snap)` → `InputStates` / `InputEvents` (streamed when
   the server has declared inputs).

The control model is selected by the `<teleport-viewer control-model="...">`
attribute (`fps` / `freefly` / `first-person` = free-fly today). Absent the
attribute the element keeps its OrbitControls inspection camera and captures no
input.

## Status

Phases 0 (foundations) and 1 (Model A free-fly) of the plan are implemented.
Models B (avatar-constrained) and C (third-person), server-authoritative
walking, and WebXR input are not yet present.
