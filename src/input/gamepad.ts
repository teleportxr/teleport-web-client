// Gamepad input device. Polls the Gamepad API on each `read()` and writes the
// connected pads' buttons and axes as canonical control paths. Stateless beyond
// the snapshot — the browser owns gamepad state, so there is nothing to bind or
// dispose. Edge detection for button events is the reporter's job.

import {
  gamepadAxis,
  gamepadButtonClick,
  gamepadButtonValue,
} from "./paths.js";
import type { DeviceSnapshot, InputDevice } from "./devices.js";

export interface GamepadInputOptions {
  /** Navigator-like source of `getGamepads()`. Defaults to the global. */
  navigatorSource?: Pick<Navigator, "getGamepads">;
}

const BUTTON_PRESS_THRESHOLD = 0.5;

export class GamepadInput implements InputDevice {
  private readonly nav?: Pick<Navigator, "getGamepads">;

  constructor(opts: GamepadInputOptions = {}) {
    this.nav =
      opts.navigatorSource ??
      (typeof navigator !== "undefined" ? navigator : undefined);
  }

  read(out: DeviceSnapshot): void {
    const pads = this.nav?.getGamepads?.() ?? [];
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad) continue;
      for (let b = 0; b < pad.buttons.length; b++) {
        const btn = pad.buttons[b];
        out.axes.set(gamepadButtonValue(i, b), btn.value);
        if (btn.pressed || btn.value >= BUTTON_PRESS_THRESHOLD) {
          out.buttons.set(gamepadButtonClick(i, b), true);
        }
      }
      for (let a = 0; a < pad.axes.length; a++) {
        out.axes.set(gamepadAxis(i, a), pad.axes[a]);
      }
    }
  }
}
