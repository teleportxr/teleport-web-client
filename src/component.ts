// <teleport-viewer> Web Component. Thin wrapper around TeleportClient + a
// Three.js renderer that mounts the streamed geometry node tree under the
// scene root via SceneAdapter.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TeleportClient, type ClientState } from "./client.js";
import { SceneAdapter } from "./scene/adapter.js";
import { AnimationController } from "./scene/animation.js";
import {
  DefaultMeshDecoder,
  DefaultTextureDecoder,
  type MeshDecoder,
  type TextureDecoder,
} from "./scene/loaders.js";
import { ResourceResolver } from "./scene/resources.js";
import { applyCubemapOrientation } from "./scene/axes.js";
import type { ParsedCommand } from "./wire/commands.js";
import {
  BackgroundMode,
  CommandPayloadType,
  LightingMode,
} from "./wire/types.js";
import { DeviceHub } from "./input/devices.js";
import { DesktopInput } from "./input/desktop.js";
import { GamepadInput } from "./input/gamepad.js";
import { FreeFlyModel } from "./input/models/freefly.js";
import { InputReporter } from "./input/report.js";
import type { ControlModel } from "./input/control_model.js";
import { buildControllerPoses } from "./wire/messages.js";

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
    return ["src", "autoconnect", "control-model"];
  }

  /** The underlying TeleportClient once `connect()` has been called.
   *  Exposed for inspection — e.g. `viewer.client.cache.textures` in DevTools.
   *  Null before connect and after disconnect. */
  client: TeleportClient | null = null;
  /** Resource resolver attached to `client.cache` once a session opens.
   *  Holds the post-decode THREE.Texture / BufferGeometry / Material objects
   *  keyed by uid. Null before connect. */
  resolver: ResourceResolver | null = null;
  private adapter: SceneAdapter | null = null;
  private animation: AnimationController | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private meshDecoder: MeshDecoder | null = null;
  private textureDecoder: TextureDecoder | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  /** Tracks which texture uid the PMREM pyramid was last built from, so we
   *  don't repeatedly re-process the same cubemap when SetupLighting is
   *  re-sent (it's an acked command). */
  private envSourceUid: bigint = 0n;
  /** Texture currently mounted as the scene background, so we can dispose
   *  the previous PMREM/equirect product when it changes. */
  private currentEnvTexture: THREE.Texture | null = null;
  private rafId = 0;
  private statusEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  // Input / control state (Phase 6). The hub + control model are created only
  // when a `control-model` attribute selects one; otherwise the element keeps
  // its OrbitControls inspection camera and captures no device input.
  private deviceHub: DeviceHub | null = null;
  private controlModel: ControlModel | null = null;
  private inputReporter = new InputReporter();
  private lastFrameMs = 0;
  private streaming = false;

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
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.0, 0);
    const light = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    this.scene.add(light);

    // Default decoders. KTX2Loader needs the renderer to pick a transcode
    // target; Draco lazily fetches its WASM transcoder on first decode.
    // DefaultMeshDecoder dispatches between glTF (GLTFLoader) and raw Draco
    // (DRACOLoader) by inspecting the buffer's magic bytes.
    this.meshDecoder = new DefaultMeshDecoder();
    this.textureDecoder = new DefaultTextureDecoder();
    this.textureDecoder.attachRenderer(this.renderer);
    // PMREMGenerator turns a cubemap (or equirect) into a pre-filtered
    // radiance pyramid that THREE.MeshStandardMaterial uses for proper PBR
    // reflections at every roughness level. We pre-create it and re-use it
    // for every SetupLighting update.
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.pmrem.compileCubemapShader();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this);
    this.handleResize();
    this.setupControl();
    this.startLoop();

    if (this.hasAttribute("autoconnect") && this.getAttribute("src")) {
      void this.connect();
    }
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.teardownControl();
    this.adapter?.detach();
    this.adapter?.clear();
    this.adapter = null;
    // Mixers hold their rigs alive; dropping the controller drops them with it.
    this.animation?.dispose();
    this.animation = null;
    this.client?.close();
    this.client = null;
    this.resolver = null;
    this.envSourceUid = 0n;
    this.currentEnvTexture?.dispose();
    this.currentEnvTexture = null;
    this.pmrem?.dispose();
    this.pmrem = null;
    this.meshDecoder?.dispose();
    this.meshDecoder = null;
    this.textureDecoder?.dispose();
    this.textureDecoder = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  attributeChangedCallback(name: string): void {
    if (name === "control-model") {
      // Only meaningful once the renderer exists (after connectedCallback).
      if (this.renderer) this.setupControl();
      return;
    }
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
    if (!this.scene) throw new Error("<teleport-viewer> not yet connected to DOM");
    const meshDecoder = this.meshDecoder;
    this.client = new TeleportClient({
      url: src,
      // Bound so AnimationPointer clips decode through the same GLTFLoader the
      // meshes use, sharing its Draco decoder. Optional on the interface: a custom
      // decoder without it leaves clips acknowledged but unplayed rather than throwing.
      animationDecoder: meshDecoder?.decodeAnimation
        ? (bytes) => meshDecoder.decodeAnimation!(bytes)
        : undefined,
    });
    this.resolver =
      this.meshDecoder && this.textureDecoder
        ? new ResourceResolver(this.client.cache, {
            meshDecoder: this.meshDecoder,
            textureDecoder: this.textureDecoder,
          })
        : null;
    this.animation = new AnimationController();
    this.client.onAnimationClip((uid, decoded) => {
      this.animation?.setClip(
        uid,
        decoded.clips[0],
        decoded.source,
        decoded.humanoidBones,
      );
    });
    this.adapter = new SceneAdapter(this.client.cache, {
      resolver: this.resolver ?? undefined,
      animation: this.animation,
    });
    this.scene.add(this.adapter.root);
    this.adapter.attach();
    this.client.onState((state) => this.handleState(state));
    this.client.onError((err) => {
      this.dispatchEvent(
        new CustomEvent("error", { detail: err, bubbles: true }),
      );
    });
    this.client.onCommand((cmd) => {
      this.applyEnvironment(cmd);
      if (cmd.kind === CommandPayloadType.SetupInputs) {
        this.inputReporter.setInputs(cmd);
      } else if (cmd.kind === CommandPayloadType.UpdateNodeMovement) {
        // Server-driven motion: nodes the server moves on our behalf, such as another
        // participant's avatar or our own follower.
        this.adapter?.applyMovements(cmd.updates);
      } else if (cmd.kind === CommandPayloadType.ApplyNodeAnimation) {
        // What that node's skeleton should be playing. Sent on a change of state, not
        // per frame, so this is recorded and kept until the next one arrives.
        this.animation?.apply(cmd);
      }
      this.dispatchEvent(
        new CustomEvent("command", { detail: cmd, bubbles: true }),
      );
    });
    await this.client.connect();
  }

  /** Apply the scene's background and environment lighting from streamed
   *  SetupCommand / SetupLightingCommand. Background mirrors `BackgroundMode`
   *  (None / Colour / Texture; Video is Phase 4); environment uses the
   *  specular cubemap when `LightingMode === Texture`. */
  private applyEnvironment(cmd: ParsedCommand): void {
    if (cmd.kind === CommandPayloadType.Setup) {
      this.applyBackground(cmd.backgroundMode, cmd.backgroundColour, cmd.backgroundTexture);
    } else if (cmd.kind === CommandPayloadType.SetupLighting) {
      this.applyLighting(cmd.lightingMode, cmd.specularTexture);
    }
  }

  private applyBackground(
    mode: BackgroundMode,
    colour: [number, number, number, number],
    textureUid: bigint,
  ): void {
    if (!this.scene) return;
    switch (mode) {
      case BackgroundMode.None:
        this.scene.background = null;
        return;
      case BackgroundMode.Colour:
        this.scene.background = new THREE.Color(colour[0], colour[1], colour[2]);
        return;
      case BackgroundMode.Texture:
        if (textureUid === 0n || !this.resolver) {
          this.scene.background = new THREE.Color(colour[0], colour[1], colour[2]);
          return;
        }
        this.resolver
          .resolveTexture(textureUid)
          .then((tex) => {
            if (!tex || !this.scene) return;
            // KTX2-encoded cubemaps come back as CubeTexture; Three uses
            // them as a skybox directly. Equirect / plain 2D textures also
            // work when `mapping` is set appropriately.
            if (!(tex as THREE.CubeTexture).isCubeTexture) {
              tex.mapping = THREE.EquirectangularReflectionMapping;
            }
            // The file need not be laid out in this client's frame; the server declares
            // which frame and leaves the conversion to us.
            this.scene.backgroundRotation.copy(applyCubemapOrientation(tex));
            this.scene.background = tex;
          })
          .catch((err) => {
            console.warn(
              `teleport-web-client: failed to load background texture ${textureUid}:`,
              err,
            );
          });
        return;
      case BackgroundMode.Video:
        // Phase 4 — handled by the video pipeline once it lands.
        return;
    }
  }

  private applyLighting(mode: LightingMode, specularTextureUid: bigint): void {
    if (!this.scene || !this.resolver || !this.pmrem) return;
    if (mode !== LightingMode.Texture || specularTextureUid === 0n) {
      this.scene.environment = null;
      return;
    }
    if (specularTextureUid === this.envSourceUid) return; // already applied
    this.envSourceUid = specularTextureUid;
    this.resolver
      .resolveTexture(specularTextureUid)
      .then((tex) => {
        if (!tex || !this.scene || !this.pmrem) return;
        if (this.envSourceUid !== specularTextureUid) return; // raced with a newer SetupLighting
        // Process the cubemap (or equirect) into the pre-filtered radiance
        // pyramid that MeshStandardMaterial samples from based on roughness.
        const isCube = !!(tex as THREE.CubeTexture).isCubeTexture;
        // Before the bake, not after: fromCubemap reads the texture's flip flag, and a product
        // baked with the wrong value stays mirrored for the life of the texture.
        const rotation = applyCubemapOrientation(tex);
        const product = isCube
          ? this.pmrem.fromCubemap(tex as THREE.CubeTexture)
          : this.pmrem.fromEquirectangular(tex);
        this.currentEnvTexture?.dispose();
        this.currentEnvTexture = product.texture;
        // PMREM preserves the source's orientation, so the declared frame still applies.
        this.scene.environmentRotation.copy(rotation);
        this.scene.environment = product.texture;
      })
      .catch((err) => {
        console.warn(
          `teleport-web-client: failed to load environment texture ${specularTextureUid}:`,
          err,
        );
      });
  }

  /** Close the connection. */
  disconnectClient(): void {
    this.client?.close();
    this.client = null;
    this.resolver = null;
    this.envSourceUid = 0n;
    if (this.scene) {
      this.scene.environment = null;
      this.scene.background = new THREE.Color(0x101418);
      this.scene.backgroundRotation.set(0, 0, 0);
      this.scene.environmentRotation.set(0, 0, 0);
    }
    this.currentEnvTexture?.dispose();
    this.currentEnvTexture = null;
  }

  private handleState(state: ClientState): void {
    this.streaming = state === "streaming";
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

  /** (Re)build the input hub and control model from the `control-model`
   *  attribute. Recognised values: "fps" / "freefly" / "first-person" enable
   *  Model A (free-fly). Anything else (or absent) reverts to OrbitControls and
   *  captures no device input. */
  private setupControl(): void {
    this.teardownControl();
    const mode = (this.getAttribute("control-model") ?? "").toLowerCase();
    const canvas = this.shadowRoot?.querySelector("canvas");
    if (!canvas) return;
    if (mode === "fps" || mode === "freefly" || mode === "first-person") {
      this.deviceHub = new DeviceHub()
        .add(new DesktopInput({ target: canvas as HTMLElement }))
        .add(new GamepadInput());
      // Seed the model from the current inspection camera so the view doesn't
      // jump when control is enabled.
      const p = this.camera?.position;
      this.controlModel = new FreeFlyModel({
        position: p ? [p.x, p.y, p.z] : undefined,
      });
      if (this.controls) this.controls.enabled = false;
    } else {
      if (this.controls) this.controls.enabled = true;
    }
  }

  private teardownControl(): void {
    this.deviceHub?.dispose();
    this.deviceHub = null;
    this.controlModel = null;
  }

  private startLoop(): void {
    this.lastFrameMs = performance.now();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      // Clamp dt so a backgrounded tab doesn't produce a huge integration step.
      const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
      this.lastFrameMs = now;
      this.driveControl(dt);
      // Advance skeletons on the session clock, not on `dt` or wall time: the states
      // being played are timestamped in it, and the controller works out its own delta.
      if (this.animation && this.client) {
        this.animation.update(this.client.sessionTimeUs());
      }
      // OrbitControls.update() always re-aims the camera at its target, even
      // when `enabled` is false — that flag only gates input. Skip it while a
      // control model owns the camera, or it would clobber the model's pose.
      if (!this.controlModel) this.controls?.update();
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Per-frame input sampling: advance the control model (camera + streamed
   *  head pose) and report declared inputs. No-op without an active control
   *  model. */
  private driveControl(dt: number): void {
    if (!this.deviceHub) return;
    const snap = this.deviceHub.sample();

    if (this.controlModel && this.camera) {
      const out = this.controlModel.update(dt, snap);
      this.camera.position.set(...out.camera.position);
      this.camera.quaternion.set(...out.camera.orientation);
      if (this.streaming && this.client) {
        this.client.sendUnreliable(
          buildControllerPoses(
            { position: out.head.position, orientation: out.head.orientation },
            [],
          ),
        );
      }
    }

    if (this.streaming && this.client) {
      const report = this.inputReporter.report(snap);
      if (report.states) this.client.sendUnreliable(report.states);
      if (report.events) this.client.sendUnreliable(report.events);
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("teleport-viewer")) {
  customElements.define("teleport-viewer", TeleportViewerElement);
}
