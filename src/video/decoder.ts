// WebCodecs-backed video decoder.
// Phase 4 placeholder. Will own a VideoDecoder instance, fan in NAL units from
// the video data channel, and surface decoded VideoFrames to the cubemap
// extractor.

import { VideoCodec, VideoPayloadType } from "../wire/types.js";

export interface VideoNalUnit {
  payloadType: VideoPayloadType;
  data: Uint8Array;
}

/** Map an avs::VideoCodec to the WebCodecs codec string family. */
export function codecString(codec: VideoCodec): string {
  switch (codec) {
    case VideoCodec.H264:
      return "avc1.640028";
    case VideoCodec.HEVC:
      return "hvc1.1.6.L120.90";
    default:
      return "";
  }
}

/** Pre-flight check: reports whether this browser can decode the codec. */
export async function isCodecSupported(codec: VideoCodec): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  const cfg = { codec: codecString(codec) };
  try {
    const r = await VideoDecoder.isConfigSupported(cfg);
    return r.supported === true;
  } catch {
    return false;
  }
}
