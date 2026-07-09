// Desktop input device: keyboard, mouse buttons, mouse motion (Pointer Lock)
// and wheel, exposed as canonical control paths.
//
// Held keys and mouse buttons are level state; mouse motion and wheel are
// per-frame deltas accumulated between `read()` calls and reset on read, so a
// consumer sampling once per frame sees the movement since the previous frame.
// Mouse motion is only meaningful while the pointer is locked, which we request
// on a click of the bound canvas.

import {
  MOUSE_MOVE_X,
  MOUSE_MOVE_Y,
  MOUSE_WHEEL_Y,
  keyboardClick,
  keyboardValue,
  mouseClick,
} from "./paths.js";
import type { DeviceSnapshot, InputDevice } from "./devices.js";

export interface DesktopInputOptions {
  /** Element that receives pointer-lock on click (usually the render canvas). */
  target: HTMLElement;
  /** Window-like event source. Defaults to the global `window`. */
  eventSource?: Window;
}

export class DesktopInput implements InputDevice {
  private readonly target: HTMLElement;
  private readonly win: Window;
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<"left" | "right" | "middle">();
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private locked = false;
  private disposed = false;
  private readonly handlers: Array<[EventTarget, string, EventListener]> = [];

  constructor(opts: DesktopInputOptions) {
    this.target = opts.target;
    this.win = opts.eventSource ?? window;
    this.bind();
  }

  read(out: DeviceSnapshot): void {
    for (const code of this.keys) {
      out.buttons.set(keyboardClick(code), true);
      out.axes.set(keyboardValue(code), 1);
    }
    for (const b of this.mouseButtons) out.buttons.set(mouseClick(b), true);
    out.axes.set(MOUSE_MOVE_X, this.dx);
    out.axes.set(MOUSE_MOVE_Y, this.dy);
    out.axes.set(MOUSE_WHEEL_Y, this.wheel);
    // Deltas are consumed; reset so they don't accumulate across frames.
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }

  /** True while the pointer is locked to the target (mouse-look active).
   *  Tracked via `pointerlockchange` rather than checking
   *  `document.pointerLockElement` directly, because the latter returns the
   *  shadow host (not the inner element) when the lock was requested on a
   *  node inside an open shadow root. */
  get pointerLocked(): boolean {
    return this.locked;
  }

  requestPointerLock(): void {
    this.target.requestPointerLock?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [t, type, fn] of this.handlers) t.removeEventListener(type, fn);
    this.handlers.length = 0;
    this.keys.clear();
    this.mouseButtons.clear();
  }

  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn);
    this.handlers.push([t, type, fn]);
  }

  private bind(): void {
    const doc = this.win.document;
    this.on(this.win as unknown as EventTarget, "keydown", (e) => {
      const code = (e as KeyboardEvent).code;
      // Don't swallow browser chrome shortcuts (Ctrl/Meta combinations).
      if ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey) return;
      this.keys.add(code);
    });
    this.on(this.win as unknown as EventTarget, "keyup", (e) => {
      this.keys.delete((e as KeyboardEvent).code);
    });
    // Lost focus: release everything so keys don't stick "down".
    this.on(this.win as unknown as EventTarget, "blur", () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });

    this.on(this.target, "click", () => {
      if (!this.pointerLocked) this.requestPointerLock();
    });
    // The lock element is exposed on `document` for top-level targets and on
    // the owning shadow root for nodes inside one; rather than probing both,
    // flip a flag from the lifecycle event itself.
    this.on(doc, "pointerlockchange", () => {
      const root = this.target.getRootNode() as Document | ShadowRoot;
      const locked = (root as { pointerLockElement?: Element | null })
        .pointerLockElement === this.target ||
        doc.pointerLockElement === this.target;
      this.locked = locked;
    });
    this.on(this.target, "mousedown", (e) => {
      this.mouseButtons.add(buttonName((e as MouseEvent).button));
    });
    this.on(doc, "mouseup", (e) => {
      this.mouseButtons.delete(buttonName((e as MouseEvent).button));
    });
    this.on(this.target, "contextmenu", (e) => e.preventDefault());
    this.on(doc, "mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.dx += (e as MouseEvent).movementX;
      this.dy += (e as MouseEvent).movementY;
    });
    this.on(
      this.target,
      "wheel",
      (e) => {
        this.wheel += (e as WheelEvent).deltaY;
        e.preventDefault();
      },
    );
  }
}

function buttonName(button: number): "left" | "right" | "middle" {
  return button === 2 ? "right" : button === 1 ? "middle" : "left";
}
