// <teleport-viewer> Web Component. Thin wrapper around TeleportClient + a
// Three.js renderer. Phase 3+ will replace the placeholder scene with the
// streamed geometry/video pipeline.

import * as THREE from "three";
import { TeleportClient, type ClientState } from "./client.js";

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host { display: block; position: relative; width: 100%; height: 100%; }
    canvas { display: block; width: 100%; height: 100%; }
    .status {
      position: absolute; top: 8px; left: 8px;
      font: 12px/1.2 system-ui, sans-serif; color: #fff;
      background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px;
      pointer-events: none;
    }
  </style>
  <canvas></canvas>
  <div class="status">idle</div>
`;

export class TeleportViewerElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["src", "autoconnect"];
  }

  private client: TeleportClient | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private rafId = 0;
  private statusEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).appendChild(
      TEMPLATE.content.cloneNode(true),
    );
  }

  connectedCallback(): void {
    const root = this.shadowRoot!;
    const canvas = root.querySelector("canvas") as HTMLCanvasElement;
    this.statusEl = root.querySelector(".status") as HTMLDivElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101418);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.camera.position.set(0, 1.6, 3);
    const light = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    this.scene.add(light);
    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x4488ff }),
    );
    this.scene.add(placeholder);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this);
    this.handleResize();
    this.startLoop(placeholder);

    if (this.hasAttribute("autoconnect") && this.getAttribute("src")) {
      void this.connect();
    }
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.client?.close();
    this.client = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  attributeChangedCallback(): void {
    // Re-trigger connect if src changed and autoconnect is on.
    if (this.client) return;
    if (this.hasAttribute("autoconnect") && this.getAttribute("src")) {
      void this.connect();
    }
  }

  /** Open the connection. May be called manually for user-gesture flows. */
  async connect(): Promise<void> {
    const src = this.getAttribute("src");
    if (!src) throw new Error("<teleport-viewer> requires a `src` attribute");
    if (this.client) return;
    this.client = new TeleportClient({ url: src });
    this.client.onState((state) => this.handleState(state));
    this.client.onError((err) => {
      this.dispatchEvent(
        new CustomEvent("error", { detail: err, bubbles: true }),
      );
    });
    this.client.onCommand((cmd) => {
      this.dispatchEvent(
        new CustomEvent("command", { detail: cmd, bubbles: true }),
      );
    });
    await this.client.connect();
  }

  /** Close the connection. */
  disconnectClient(): void {
    this.client?.close();
    this.client = null;
  }

  private handleState(state: ClientState): void {
    if (this.statusEl) this.statusEl.textContent = state;
    // A single "state" event carries the phase as detail. Earlier versions
    // also dispatched an event named after the state itself, but that
    // collides with the dedicated "error" event when state === "error".
    this.dispatchEvent(
      new CustomEvent("state", { detail: state, bubbles: true }),
    );
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) return;
    const rect = this.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private startLoop(spinner: THREE.Mesh): void {
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      spinner.rotation.x += 0.005;
      spinner.rotation.y += 0.01;
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("teleport-viewer")) {
  customElements.define("teleport-viewer", TeleportViewerElement);
}
