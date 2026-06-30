// InputReporter: regex binding, state ordering, and event edge detection.

import { describe, expect, it } from "vitest";
import { InputReporter } from "../src/input/report.js";
import { emptySnapshot } from "../src/input/devices.js";
import { keyboardClick, keyboardValue } from "../src/input/paths.js";
import { BufferReader } from "../src/wire/reader.js";
import { ClientMessagePayloadType, CommandPayloadType } from "../src/wire/types.js";
import type { SetupInputsCommand } from "../src/wire/commands.js";

// InputType values from input.rst.
const IntegerState = 4;
const FloatState = 8;
const IntegerEvent = 5;

function setup(inputs: SetupInputsCommand["inputs"]): SetupInputsCommand {
  return { kind: CommandPayloadType.SetupInputs, inputs };
}

describe("InputReporter", () => {
  it("binds a boolean state to a keyboard click and packs the bitfield", () => {
    const r = new InputReporter();
    r.setInputs(
      setup([{ inputId: 1, inputType: IntegerState, regexPath: "/user/keyboard/KeyW/click" }]),
    );
    expect(r.hasStateInputs).toBe(true);

    const snap = emptySnapshot();
    snap.buttons.set(keyboardClick("KeyW"), true);
    const { states } = r.report(snap);
    expect(states).not.toBeNull();

    const br = new BufferReader(states!);
    expect(br.u8()).toBe(ClientMessagePayloadType.InputStates);
    br.i64(); // timestamp
    expect(br.u16()).toBe(1); // numBinary
    expect(br.u16()).toBe(0); // numAnalogue
    expect(br.u8() & 1).toBe(1); // bit 0 set
  });

  it("reports a float state from the analogue array", () => {
    const r = new InputReporter();
    r.setInputs(
      setup([{ inputId: 7, inputType: FloatState, regexPath: "/user/keyboard/KeyW/value" }]),
    );
    const snap = emptySnapshot();
    snap.axes.set(keyboardValue("KeyW"), 1);
    const br = new BufferReader(r.report(snap).states!);
    br.u8();
    br.i64();
    expect(br.u16()).toBe(0); // numBinary
    expect(br.u16()).toBe(1); // numAnalogue
    expect(br.f32()).toBeCloseTo(1);
  });

  it("emits a binary event only on the press edge", () => {
    const r = new InputReporter();
    r.setInputs(
      setup([{ inputId: 3, inputType: IntegerEvent, regexPath: "/user/keyboard/Space/click" }]),
    );
    const idle = emptySnapshot();
    expect(r.report(idle).events).toBeNull();

    const pressed = emptySnapshot();
    pressed.buttons.set(keyboardClick("Space"), true);
    const first = r.report(pressed);
    expect(first.events).not.toBeNull();
    // Held: no new event on the next frame.
    expect(r.report(pressed).events).toBeNull();
  });

  it("reports an unmatched input as an empty slot rather than dropping it", () => {
    const r = new InputReporter();
    r.setInputs(
      setup([{ inputId: 9, inputType: IntegerState, regexPath: "/no/such/control" }]),
    );
    const br = new BufferReader(r.report(emptySnapshot()).states!);
    br.u8();
    br.i64();
    expect(br.u16()).toBe(1); // slot still present
    expect(br.u16()).toBe(0);
    expect(br.u8() & 1).toBe(0); // reports false
  });
});
