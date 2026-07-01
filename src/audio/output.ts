// WebRTCAudio — owns the AudioContext for remote track playback and
// the getUserMedia mic track sent to the server.
//
// Design notes:
//   • An AudioContext is created on first attachIncomingTrack() call so we
//     stay off the "autoplay blocked" path until user gesture or until we
//     actually have audio to play.
//   • Mic capture is requested explicitly by the caller once the SetupCommand
//     indicates audioInputEnabled.  The caller must add the returned track to
//     the peer connection BEFORE or AFTER the offer/answer cycle:
//       - Before: track appears in the SDP answer sent to the server.
//       - After: use RTCRtpSender.replaceTrack() on the existing transceiver
//         (no renegotiation needed in most browsers).
//   • close() stops all mic tracks and closes the AudioContext.

/** Options forwarded from SetupCommand.audioConfig. */
export interface AudioOutputOptions {
  sampleRate?: number;
}

/** Emitter parameters bound to a stream index (from an AudioEmitter component). */
export interface EmitterBinding {
  spatialised: boolean;
  gain: number;
  minDistanceMetres: number;
  maxDistanceMetres: number;
}

/** Audio graph created for one bound stream index. */
interface StreamNode {
  gain: GainNode;
  panner: PannerNode | null;
}

/**
 * Manages browser-side WebRTC audio: plays back incoming remote tracks via
 * the Web Audio API and provides microphone capture for the server.
 *
 * Remote tracks and audio-emitter components both carry an abstract audio
 * stream index (the track's SDP `mid`); they are correlated here so playback
 * gain and spatialisation follow the emitter that names the stream.
 */
export class WebRTCAudio {
  private context: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private readonly sampleRate: number;
  private readonly streams = new Map<number, StreamNode>();
  // Emitter params that arrived (on the geometry channel) before their track.
  private readonly pendingEmitters = new Map<number, EmitterBinding>();

  constructor(opts: AudioOutputOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  /**
   * Attach a remote MediaStreamTrack (received via RTCPeerConnection `track`
   * event) to the AudioContext for playback.  Creates the AudioContext on first
   * call so that it is created inside a user-gesture context when possible.
   *
   * When `streamIndex` is supplied (parsed from the track's `mid`), the track is
   * routed through a gain (and, for spatialised emitters, a panner) node so a
   * later or earlier AudioEmitter component can control it via applyEmitter().
   */
  attachIncomingTrack(track: MediaStreamTrack, streamIndex?: number): void {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
    }
    const stream = new MediaStream([track]);
    const source = this.context.createMediaStreamSource(stream);

    if (streamIndex !== undefined && streamIndex > 0) {
      const gain = this.context.createGain();
      const binding = this.pendingEmitters.get(streamIndex);
      let panner: PannerNode | null = null;
      if (binding?.spatialised) {
        panner = this.makePanner(binding);
        source.connect(panner);
        panner.connect(gain);
      } else {
        source.connect(gain);
      }
      gain.gain.value = binding?.gain ?? 1.0;
      gain.connect(this.context.destination);
      this.streams.set(streamIndex, { gain, panner });
      this.pendingEmitters.delete(streamIndex);
    } else {
      source.connect(this.context.destination);
    }

    // Resume the context if it was suspended (autoplay policy).
    if (this.context.state === "suspended") {
      this.context.resume().catch(() => {
        // The browser may still block it until the next user gesture;
        // audio will start automatically once the context is resumed.
      });
    }
  }

  /**
   * Apply (or update) an emitter's parameters to the stream it names. Called
   * when an AudioEmitter component is decoded on the geometry channel. If the
   * track has not yet arrived the parameters are cached and applied on attach.
   */
  applyEmitter(streamIndex: number, binding: EmitterBinding): void {
    if (streamIndex <= 0) return;
    const node = this.streams.get(streamIndex);
    if (!node) {
      this.pendingEmitters.set(streamIndex, binding);
      return;
    }
    node.gain.gain.value = binding.gain;
    if (node.panner && binding.spatialised) {
      node.panner.refDistance = binding.minDistanceMetres;
      node.panner.maxDistance = binding.maxDistanceMetres;
    }
  }

  /** Set the world position of a spatialised emitter's panner. */
  setEmitterPosition(streamIndex: number, x: number, y: number, z: number): void {
    const panner = this.streams.get(streamIndex)?.panner;
    if (!panner) return;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  }

  private makePanner(binding: EmitterBinding): PannerNode {
    const panner = this.context!.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = binding.minDistanceMetres;
    panner.maxDistance = binding.maxDistanceMetres;
    return panner;
  }

  // ── Microphone capture ────────────────────────────────────────────────────

  /**
   * Request microphone access from the browser. Returns the first audio track
   * from the granted stream.  The caller should add this track to the peer
   * connection so it is sent to the server.
   *
   * Throws if the user denies permission or the device is unavailable.
   */
  async requestMicTrack(): Promise<MediaStreamTrack> {
    if (this.micStream) {
      // Return the existing track if already captured.
      const existing = this.micStream.getAudioTracks()[0];
      if (existing) return existing;
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const track = this.micStream.getAudioTracks()[0];
    if (!track) throw new Error("getUserMedia returned no audio tracks");
    return track;
  }

  /**
   * Stop all microphone tracks and close the AudioContext.
   * Safe to call more than once.
   */
  close(): void {
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    this.streams.clear();
    this.pendingEmitters.clear();
    if (this.context) {
      this.context.close().catch(() => {/* ignore */});
      this.context = null;
    }
  }
}

