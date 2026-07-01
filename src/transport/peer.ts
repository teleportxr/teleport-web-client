// RTCPeerConnection wrapper that exposes the six pre-negotiated Teleport data
// channels by their server-side label. The reference server creates the channels
// (see teleport-nodejs/connections/webrtcconnection.js#beforeOffer) so this side
// only needs to receive them through the `datachannel` event.

import { ChannelLabel } from "../wire/types.js";

export type ChannelKey = keyof typeof ChannelLabel;

export interface PeerHandlers {
  onIceCandidate?: (candidate: RTCIceCandidate) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onChannel?: (key: ChannelKey, channel: RTCDataChannel) => void;
  onMessage?: (key: ChannelKey, data: ArrayBuffer) => void;
  /** Fired when a remote media track is received (e.g. server-forwarded audio). */
  onTrack?: (
    track: MediaStreamTrack,
    streams: readonly MediaStream[],
    transceiver: RTCRtpTransceiver,
  ) => void;
}

const LABEL_TO_KEY: Record<string, ChannelKey> = Object.fromEntries(
  (Object.entries(ChannelLabel) as [ChannelKey, string][]).map(([k, v]) => [
    v,
    k,
  ]),
);

export class TeleportPeerConnection {
  readonly pc: RTCPeerConnection;
  readonly channels: Partial<Record<ChannelKey, RTCDataChannel>> = {};
  private handlers: PeerHandlers = {};

  constructor(config?: RTCConfiguration) {
    this.pc = new RTCPeerConnection(
      config ?? {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      },
    );
    this.pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) this.handlers.onIceCandidate?.(ev.candidate);
    });
    this.pc.addEventListener("connectionstatechange", () => {
      this.handlers.onConnectionStateChange?.(this.pc.connectionState);
    });
    this.pc.addEventListener("datachannel", (ev) => this.bind(ev.channel));
    this.pc.addEventListener("track", (ev) => {
      this.handlers.onTrack?.(ev.track, ev.streams, ev.transceiver);
    });
  }

  on(handlers: PeerHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Add a local media track to the peer connection so it is included in the
   * next SDP answer (for sending the microphone to the server).
   */
  addTrack(track: MediaStreamTrack): RTCRtpSender {
    return this.pc.addTrack(track);
  }

  /** Apply the offer SDP from the server, build and return the answer SDP. */
  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (!answer.sdp) throw new Error("failed to create answer SDP");
    return answer.sdp;
  }

  async addRemoteCandidate(
    candidate: string,
    mid: string,
    mlineindex: number,
  ): Promise<void> {
    if (!candidate) return;
    await this.pc.addIceCandidate(
      new RTCIceCandidate({
        candidate,
        sdpMid: mid,
        sdpMLineIndex: mlineindex,
      }),
    );
  }

  /** Send on a known channel by key. Throws if the channel is not yet open. */
  send(key: ChannelKey, data: ArrayBuffer | ArrayBufferView): void {
    const dc = this.channels[key];
    if (!dc) throw new Error(`channel '${key}' not yet established`);
    if (dc.readyState !== "open") {
      throw new Error(`channel '${key}' is in state ${dc.readyState}`);
    }
    if (data instanceof ArrayBuffer) {
      dc.send(data);
    } else if (ArrayBuffer.isView(data)) {
      // Send the exact view, not the underlying buffer (which may be larger).
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      dc.send(copy);
    } else {
      throw new TypeError("send(): data must be ArrayBuffer or ArrayBufferView");
    }
  }

  close(): void {
    for (const dc of Object.values(this.channels)) {
      try {
        dc?.close();
      } catch {
        // best-effort
      }
    }
    this.pc.close();
  }

  private bind(channel: RTCDataChannel): void {
    const key = LABEL_TO_KEY[channel.label] as ChannelKey | undefined;
    if (!key) {
      // Unknown channel — close it so the server is aware.
      channel.close();
      return;
    }
    channel.binaryType = "arraybuffer";
    this.channels[key] = channel;
    channel.addEventListener("open", () => {
      this.handlers.onChannel?.(key, channel);
    });
    channel.addEventListener("message", (ev) => {
      const data = ev.data as ArrayBuffer;
      if (data instanceof ArrayBuffer) {
        this.handlers.onMessage?.(key, data);
      }
    });
  }
}
