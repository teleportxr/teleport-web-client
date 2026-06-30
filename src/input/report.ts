// Input reporter: turns the server's declared inputs into the per-frame
// InputStates / InputEvents messages.
//
// On SetupInputsCommand each declared regex is resolved, once, against the web
// client's advertised canonical control list (the enumerable subset of the
// paths.ts tree). The first matching control of the right kind (boolean for
// integer inputs, float for float inputs) is bound; an input with no match
// still occupies its slot, reporting false / 0.0, so the bitfield and analogue
// array stay index-aligned with the server's expectations (input.rst).
//
// This layer carries only abstract actions — buttons, triggers, declared axes.
// Locomotion that a control model integrates locally does not pass through here;
// see the design plan for the split.

import {
  CROUCH_VALUE,
  JUMP_CLICK,
  LOOK_PITCH,
  LOOK_YAW,
  MOUSE_MOVE_X,
  MOUSE_MOVE_Y,
  MOUSE_WHEEL_Y,
  MOVE_X,
  MOVE_Y,
  MOVE_Z,
  SPRINT_VALUE,
  gamepadAxis,
  gamepadButtonClick,
  gamepadButtonValue,
  keyboardClick,
  keyboardValue,
  mouseClick,
} from "./paths.js";
import {
  snapshotAxis,
  snapshotButton,
  type DeviceSnapshot,
} from "./devices.js";
import {
  buildInputEvents,
  buildInputStates,
  type AnalogueEvent,
  type BinaryEvent,
} from "../wire/messages.js";
import type { SetupInputsCommand } from "../wire/commands.js";

// InputType bitfield (Teleport/docs/protocol/input.rst).
const IS_EVENT = 1;
const IS_RELEASE_EVENT = 2;
const IS_FLOAT = 8;

interface ResolvedInput {
  inputId: number;
  isFloat: boolean;
  isEvent: boolean;
  isReleaseEvent: boolean;
  /** Bound canonical path, or null when no control matched. */
  path: string | null;
}

export interface InputReport {
  /** Per-frame state message; null when the server declared no state inputs. */
  states: Uint8Array | null;
  /** Event message; null when no event fired this frame. */
  events: Uint8Array | null;
}

export class InputReporter {
  private states: ResolvedInput[] = [];
  private events: ResolvedInput[] = [];
  private prevBool = new Map<number, boolean>();
  private prevFloat = new Map<number, number>();
  private eventCounter = 0;

  /** Bind to a new SetupInputsCommand, discarding all previous bindings
   *  (InputIds are invalidated wholesale; see input.rst). */
  setInputs(cmd: SetupInputsCommand): void {
    this.states = [];
    this.events = [];
    this.prevBool.clear();
    this.prevFloat.clear();
    for (const def of cmd.inputs) {
      const isFloat = (def.inputType & IS_FLOAT) !== 0;
      const resolved: ResolvedInput = {
        inputId: def.inputId,
        isFloat,
        isEvent: (def.inputType & IS_EVENT) !== 0,
        isReleaseEvent: (def.inputType & IS_RELEASE_EVENT) !== 0,
        path: resolvePath(def.regexPath, isFloat),
      };
      (resolved.isEvent ? this.events : this.states).push(resolved);
    }
  }

  /** True when at least one state input is declared (so an InputStates message
   *  is worth sending each frame). */
  get hasStateInputs(): boolean {
    return this.states.length > 0;
  }

  /** Produce this frame's messages from a device snapshot. */
  report(snap: DeviceSnapshot): InputReport {
    return { states: this.buildStates(snap), events: this.buildEvents(snap) };
  }

  private buildStates(snap: DeviceSnapshot): Uint8Array | null {
    if (this.states.length === 0) return null;
    const binary: boolean[] = [];
    const analogue: number[] = [];
    for (const inp of this.states) {
      if (inp.isFloat) analogue.push(inp.path ? snapshotAxis(snap, inp.path) : 0);
      else binary.push(inp.path ? snapshotButton(snap, inp.path) : false);
    }
    return buildInputStates(binary, analogue);
  }

  private buildEvents(snap: DeviceSnapshot): Uint8Array | null {
    const binary: BinaryEvent[] = [];
    const analogue: AnalogueEvent[] = [];
    for (const inp of this.events) {
      if (inp.isFloat) {
        const v = inp.path ? snapshotAxis(snap, inp.path) : 0;
        const prev = this.prevFloat.get(inp.inputId) ?? 0;
        if (Math.abs(v - prev) > 1e-4) {
          analogue.push({ eventId: this.eventCounter++, inputId: inp.inputId, strength: v });
          this.prevFloat.set(inp.inputId, v);
        }
      } else {
        const v = inp.path ? snapshotButton(snap, inp.path) : false;
        const prev = this.prevBool.get(inp.inputId) ?? false;
        if (v && !prev) {
          binary.push({ eventId: this.eventCounter++, inputId: inp.inputId, activated: true });
        } else if (!v && prev && inp.isReleaseEvent) {
          binary.push({ eventId: this.eventCounter++, inputId: inp.inputId, activated: false });
        }
        this.prevBool.set(inp.inputId, v);
      }
    }
    // Motion (2D) events are not produced: the web client's 2D intents are the
    // derived locomotion axes, consumed by control models rather than declared
    // as motion inputs. Left empty until a server use-case needs them.
    if (binary.length === 0 && analogue.length === 0) return null;
    return buildInputEvents(binary, analogue, []);
  }
}

// A representative, finite slice of the (otherwise unbounded) path tree. Enough
// for servers to author portable regexes against keyboard, mouse, a first
// gamepad and the derived locomotion axes. Declared before the control lists
// below, which consume it at module-init time.
const KEY_CODES = (() => {
  const codes: string[] = [];
  for (let c = 65; c <= 90; c++) codes.push(`Key${String.fromCharCode(c)}`);
  for (let d = 0; d <= 9; d++) codes.push(`Digit${d}`);
  codes.push(
    "Space", "Enter", "Escape", "Tab", "Backspace",
    "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  );
  return codes;
})();

/** The advertised canonical controls, split by kind, in match-priority order.
 *  Regex resolution scans these; a held-state device need not currently expose
 *  a control for it to be bindable. */
const BOOLEAN_CONTROLS = enumerateBooleanControls();
const FLOAT_CONTROLS = enumerateFloatControls();

function resolvePath(pattern: string, isFloat: boolean): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null; // malformed server regex — leave unbound (reports 0 / false).
  }
  const candidates = isFloat ? FLOAT_CONTROLS : BOOLEAN_CONTROLS;
  for (const path of candidates) if (re.test(path)) return path;
  return null;
}

function enumerateBooleanControls(): string[] {
  const out: string[] = [];
  for (const code of KEY_CODES) out.push(keyboardClick(code));
  for (const b of ["left", "right", "middle"] as const) out.push(mouseClick(b));
  for (let n = 0; n < 16; n++) out.push(gamepadButtonClick(0, n));
  out.push(JUMP_CLICK);
  return out;
}

function enumerateFloatControls(): string[] {
  const out: string[] = [];
  for (const code of KEY_CODES) out.push(keyboardValue(code));
  out.push(MOUSE_MOVE_X, MOUSE_MOVE_Y, MOUSE_WHEEL_Y);
  for (let n = 0; n < 16; n++) out.push(gamepadButtonValue(0, n));
  for (let a = 0; a < 4; a++) out.push(gamepadAxis(0, a));
  out.push(MOVE_X, MOVE_Y, MOVE_Z, LOOK_YAW, LOOK_PITCH, SPRINT_VALUE, CROUCH_VALUE);
  return out;
}
