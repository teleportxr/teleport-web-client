// Wire-format tests for the server -> client command parsers.
// Each fixture is built byte-for-byte to match the corresponding C++ packed
// struct in TeleportCore/CommonNetworking.h, then fed through parseCommand().

import { describe, expect, it } from "vitest";
import { BufferWriter } from "../src/wire/writer.js";
import {
  AxesStandard,
  BackgroundMode,
  CommandPayloadType,
  LightingMode,
  VideoCodec,
} from "../src/wire/types.js";
import {
  parseCommand,
  type AcknowledgeHandshakeCommand,
  type SetupCommand,
  type SetupLightingCommand,
} from "../src/wire/commands.js";

/** Build a SetupCommand byte-buffer matching sizeof == 154. */
function makeSetupCommandBytes(): Uint8Array {
  const w = new BufferWriter(154);
  w.u8(CommandPayloadType.Setup);
  w.u32(0).u32(0).i32(0).u32(5000).u64(0xdeadbeefn);
  // VideoConfig (89 bytes): 14 u32s + 1 f32 + 1 f32 + ... follows readVideoConfig order
  w.u32(1024).u32(1024); // video_width / height
  w.u32(512).u32(512); // depth
  w.u32(1280).u32(720); // perspective
  w.f32(110).f32(0.5); // fov, near
  w.u32(640).u32(480).i32(0).i32(0); // webcam
  w.u32(0).u32(0).u32(1); // 10bit/444/alpha
  w.u32(2048).i32(0).i32(1).i32(0); // colour_cubemap_size, compose, useCubemap, streamWebcam
  w.u8(VideoCodec.H264);
  w.i32(0).i32(0).i32(0); // shadowmap x,y,size
  // Tail of SetupCommand
  w.f32(50.0); // draw_distance
  w.u8(AxesStandard.GlStyle);
  w.u8(0).bool(true); // audio_input_enabled, using_ssl
  w.i64(1700000000000000n); // startTimestamp_utc_unix_us
  w.u8(BackgroundMode.Colour);
  w.vec4(0.1, 0.2, 0.3, 1.0);
  w.u64(7n); // backgroundTexture
  return w.toUint8Array();
}

describe("parseCommand", () => {
  it("decodes a Shutdown packet (1 byte)", () => {
    const cmd = parseCommand(new Uint8Array([CommandPayloadType.Shutdown]));
    expect(cmd.kind).toBe(CommandPayloadType.Shutdown);
  });

  it("decodes a PingForLatency with the timestamp echoed back", () => {
    const w = new BufferWriter();
    w.u8(CommandPayloadType.PingForLatency).i64(1234567890n);
    const cmd = parseCommand(w.toUint8Array());
    expect(cmd.kind).toBe(CommandPayloadType.PingForLatency);
    if (cmd.kind === CommandPayloadType.PingForLatency) {
      expect(cmd.unixTimeUs).toBe(1234567890n);
    }
  });

  it("decodes a SetupCommand of exactly 154 bytes", () => {
    const bytes = makeSetupCommandBytes();
    expect(bytes.byteLength).toBe(154);
    const cmd = parseCommand(bytes) as SetupCommand;
    expect(cmd.kind).toBe(CommandPayloadType.Setup);
    expect(cmd.idleConnectionTimeout).toBe(5000);
    expect(cmd.sessionId).toBe(0xdeadbeefn);
    expect(cmd.axesStandard).toBe(AxesStandard.GlStyle);
    expect(cmd.backgroundMode).toBe(BackgroundMode.Colour);
    expect(cmd.backgroundColour).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
      1.0,
    ]);
    expect(cmd.backgroundTexture).toBe(7n);
    expect(cmd.videoConfig.videoWidth).toBe(1024);
    expect(cmd.videoConfig.videoCodec).toBe(VideoCodec.H264);
    expect(cmd.videoConfig.colourCubemapSize).toBe(2048);
  });

  it("decodes an AcknowledgeHandshake with appended uids", () => {
    const w = new BufferWriter();
    w.u8(CommandPayloadType.AcknowledgeHandshake).u64(3n);
    w.u64(101n).u64(202n).u64(303n);
    const cmd = parseCommand(w.toUint8Array()) as AcknowledgeHandshakeCommand;
    expect(cmd.kind).toBe(CommandPayloadType.AcknowledgeHandshake);
    expect(cmd.visibleNodes).toEqual([101n, 202n, 303n]);
  });

  it("decodes a SetupLighting with trailing GI texture uids", () => {
    const w = new BufferWriter();
    w.u8(CommandPayloadType.SetupLighting);
    w.u64(42n); // ack_id
    w.i32(0).i32(0); // specularPos
    w.i32(512).i32(5); // specularCubemapSize, mips
    w.i32(0).i32(0); // diffusePos
    w.i32(64); // diffuseCubemapSize
    w.i32(0).i32(0); // lightPos
    w.i32(32); // lightCubemapSize
    w.u64(11n).u64(22n); // specular/diffuse cubemap uids
    w.u8(LightingMode.Texture);
    w.u64(91n).u64(92n); // two trailing uids
    const cmd = parseCommand(w.toUint8Array()) as SetupLightingCommand;
    expect(cmd.kind).toBe(CommandPayloadType.SetupLighting);
    expect(cmd.ackId).toBe(42n);
    expect(cmd.lightingMode).toBe(LightingMode.Texture);
    expect(cmd.specularTexture).toBe(11n);
    expect(cmd.diffuseTexture).toBe(22n);
    expect(cmd.giTextures).toEqual([91n, 92n]);
  });

  it("decodes a NodeVisibility with show/hide lists", () => {
    const w = new BufferWriter();
    w.u8(CommandPayloadType.NodeVisibility);
    w.u64(2n).u64(1n);
    w.u64(10n).u64(20n);
    w.u64(99n);
    const cmd = parseCommand(w.toUint8Array());
    expect(cmd.kind).toBe(CommandPayloadType.NodeVisibility);
    if (cmd.kind === CommandPayloadType.NodeVisibility) {
      expect(cmd.showNodes).toEqual([10n, 20n]);
      expect(cmd.hideNodes).toEqual([99n]);
    }
  });
});
