// Install the browser globals that teleport-web-client expects so its
// modules can be imported and run under Node. Must be imported BEFORE
// any import from teleport-web-client/dist.

import { WebSocket } from "ws";
import wrtc from "@roamhq/wrtc";

if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;
if (!globalThis.RTCPeerConnection)
  globalThis.RTCPeerConnection = wrtc.RTCPeerConnection;
if (!globalThis.RTCIceCandidate)
  globalThis.RTCIceCandidate = wrtc.RTCIceCandidate;
if (!globalThis.RTCSessionDescription)
  globalThis.RTCSessionDescription = wrtc.RTCSessionDescription;

// teleport-web-client's bundle re-exports the <teleport-viewer> Web Component
// from index.ts, and that module touches `document` and `HTMLElement` at top
// level. The headless harness never instantiates it; stub just enough that
// the module body evaluates without throwing. The `customElements.define`
// call is already guarded with `typeof customElements`, so we leave that
// undefined and it silently skips.
if (!globalThis.HTMLElement) globalThis.HTMLElement = class {};
if (!globalThis.document)
  globalThis.document = { createElement: () => ({ innerHTML: "" }) };
