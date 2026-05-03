// Wire-format tests for the client -> server message builders.
// Verifies the byte layout matches the packed C++ structs.

import { describe, expect, it } from "vitest";
import { BufferReader } from "../src/wire/reader.js";
import {
  buildAcknowledgement,
  buildControllerPoses,
  buildHandshake,
  buildInputStates,
  buildKeyframeRequest,
  buildPongForLatency,
} from "../src/wire/messages.js";
import {
  AxesStandard,
  ClientMessagePayloadType,
} from "../src/wire/types.js";

describe("client message builders", () => {
  it("buildHandshake matches sizeof(Handshake) == 58 with no extra resources", () => {
    const bytes = buildHandshake({
      displayInfo: { width: 1920, height: 1080, framerate: 90 },
      axesStandard: AxesStandard.GlStyle,
      framerate: 90,
      isVR: true,
    });
    // ClientMessage header is 9 (1+8). Handshake adds 49 more (sizeof check
    // says 58 total). RenderingFeatures is 2 bytes; there is also a
    // single-byte trailing alignment vs. the C++ static_assert. The C++
    // static_assert == 58 is for the entire packet; we mirror it here.
    expect(bytes.byteLength).toBe(58);
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(ClientMessagePayloadType.Handshake);
    r.i64(); // timestamp
    expect(r.u32()).toBe(1920);
    expect(r.u32()).toBe(1080);
    expect(r.f32()).toBeCloseTo(90);
    expect(r.f32()).toBeCloseTo(1); // metresPerUnit
    expect(r.f32()).toBeCloseTo(90); // FOV
    expect(r.u32()).toBe(0); // udpBufferSizeKb
    expect(r.u32()).toBe(0); // maxBandwidthKbps
    expect(r.u8()).toBe(AxesStandard.GlStyle);
    expect(r.u8()).toBe(90); // framerate
    expect(r.bool()).toBe(true); // isVR
    expect(r.u64()).toBe(0n); // resourceCount
    expect(r.u32()).toBe(0); // maxLightsSupported
    expect(r.i32()).toBe(0); // minimumPriority
    expect(r.bool()).toBe(false); // RenderingFeatures.normals
    expect(r.bool()).toBe(false); // RenderingFeatures.ambientOcclusion
    expect(r.remaining).toBe(0);
  });

  it("buildHandshake appends resourceCount uids after the header", () => {
    const bytes = buildHandshake({
      displayInfo: { width: 1, height: 1, framerate: 60 },
      axesStandard: AxesStandard.GlStyle,
      framerate: 60,
      isVR: false,
      resourceUids: [1n, 2n, 3n],
    });
    expect(bytes.byteLength).toBe(58 + 3 * 8);
  });

  it("buildPongForLatency echoes the original ns and reports the latency", () => {
    const bytes = buildPongForLatency(1234n, 5678n);
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(ClientMessagePayloadType.PongForLatency);
    r.i64();
    expect(r.i64()).toBe(1234n);
    expect(r.i64()).toBe(5678n);
  });

  it("buildAcknowledgement carries the ack_id", () => {
    const bytes = buildAcknowledgement(42n);
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(ClientMessagePayloadType.Acknowledgement);
    r.i64();
    expect(r.u64()).toBe(42n);
  });

  it("buildKeyframeRequest is a header-only packet", () => {
    const bytes = buildKeyframeRequest();
    expect(bytes.byteLength).toBe(9);
    expect(bytes[0]).toBe(ClientMessagePayloadType.KeyframeRequest);
  });

  it("buildControllerPoses matches sizeof(NodePosesMessage) == 39 base", () => {
    // 1.5 chosen because it round-trips exactly through f32.
    const bytes = buildControllerPoses(
      { position: [0, 1.5, 0], orientation: [0, 0, 0, 1] },
      [],
    );
    expect(bytes.byteLength).toBe(39);
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(ClientMessagePayloadType.ControllerPoses);
    r.i64();
    expect(r.vec4()).toEqual([0, 0, 0, 1]); // orientation
    expect(r.vec3()).toEqual([0, 1.5, 0]); // position
    expect(r.u16()).toBe(0); // numPoses
  });

  it("buildInputStates packs the binary bitfield LSB-first", () => {
    const bytes = buildInputStates(
      [true, false, true, false, false, false, false, true],
      [0.25, -0.5],
    );
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(ClientMessagePayloadType.InputStates);
    r.i64();
    expect(r.u16()).toBe(8); // numBinary
    expect(r.u16()).toBe(2); // numAnalogue
    expect(r.u8()).toBe(0b10000101);
    expect(r.f32()).toBeCloseTo(0.25);
    expect(r.f32()).toBeCloseTo(-0.5);
  });
});
