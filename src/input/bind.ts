// Input binding from regex paths to local control sources.
// Phase 6 placeholder. The server sends a SetupInputsCommand whose
// `regexPath` for each InputDefinition is matched against the canonical
// path strings exposed by the desktop / gamepad / WebXR backends.

import type { SetupInputsCommand } from "../wire/commands.js";

export interface InputBinding {
  inputId: number;
  inputType: number;
  regex: RegExp;
}

export function compileBindings(cmd: SetupInputsCommand): InputBinding[] {
  return cmd.inputs.map((i) => ({
    inputId: i.inputId,
    inputType: i.inputType,
    regex: new RegExp(i.regexPath),
  }));
}
