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

/** Audio graph created for one spatialised source node. */
interface StreamNode {
  panner: PannerNode;
}

/** Default panner rolloff (metres). Gain/rolloff are no longer carried on the
 *  wire; a client-side default is used until a real authoring case appears. */
const DEFAULT_REF_DISTANCE = 1.0;
const DEFAULT_MAX_DISTANCE = 100.0;

/**
 * Manages browser-side WebRTC audio: plays back incoming remote tracks via
 * the Web Audio API and provides microphone capture for the server.
 *
 * A remote track's SDP `mid` is the decimal uid of the emitting scene node
 * (see docs/protocol/audio.rst). A track whose mid names a node is spatialised
 * at that node's transform; a track with no node (mid "0"/absent) plays
 * non-spatially. The map is therefore keyed by the node uid string.
 */
export class WebRTCAudio {
  private context: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private readonly sampleRate: number;
  private readonly streams = new Map<string, StreamNode>();

  constructor(opts: AudioOutputOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  /**
   * Attach a remote MediaStreamTrack (received via RTCPeerConnection `track`
   * event) to the AudioContext for playback.  Creates the AudioContext on first
   * call so that it is created inside a user-gesture context when possible.
   *
   * When `nodeUid` is supplied (the track's `mid` = emitting node uid), the
   * track is routed through an HRTF panner positioned via setEmitterPosition();
   * otherwise it plays non-spatially straight to the destination.
   */
  attachIncomingTrack(track: MediaStreamTrack, nodeUid?: string): void {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      console.log("[audio] AudioContext created, state=", this.context.state);
    }
    const stream = new MediaStream([track]);
    const source = this.context.createMediaStreamSource(stream);

    if (nodeUid !== undefined && nodeUid !== "0") {
      const panner = this.makePanner();
      source.connect(panner);
      panner.connect(this.context.destination);
      this.streams.set(nodeUid, { panner });
    } else {
      source.connect(this.context.destination);
    }
    console.log("[audio] attached incoming track, nodeUid=", nodeUid, "context.state=", this.context.state);

    // Resume the context if it was suspended (autoplay policy).
    if (this.context.state === "suspended") {
      this.context.resume().then(() => {
        console.log("[audio] context.resume() succeeded, state=", this.context?.state);
      }).catch((err) => {
        // The browser may still block it until the next user gesture;
        // audio will start automatically once the context is resumed.
        console.warn("[audio] context.resume() failed, still suspended until a user gesture:", err);
      });
    }
  }

  /** Set the world position of a spatialised source node's panner. */
  setEmitterPosition(nodeUid: string, x: number, y: number, z: number): void {
    const panner = this.streams.get(nodeUid)?.panner;
    if (!panner) return;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  }

  private makePanner(): PannerNode {
    const panner = this.context!.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = DEFAULT_REF_DISTANCE;
    panner.maxDistance = DEFAULT_MAX_DISTANCE;
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
    if (this.context) {
      this.context.close().catch(() => {/* ignore */});
      this.context = null;
    }
  }
}

