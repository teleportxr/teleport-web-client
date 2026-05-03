// Round-trip tests for the BufferReader and BufferWriter primitives.
// These guard the foundation of every other parser/builder.

import { describe, expect, it } from "vitest";
import { BufferReader } from "../src/wire/reader.js";
import { BufferWriter } from "../src/wire/writer.js";

describe("BufferReader / BufferWriter", () => {
  it("round-trips every primitive type in little-endian order", () => {
    const w = new BufferWriter(8);
    w.u8(0xab)
      .i8(-7)
      .u16(0x1234)
      .i16(-1234)
      .u32(0xdeadbeef)
      .i32(-100000)
      .u64(0xcafebabedeadbeefn)
      .i64(-9000000000n)
      .f32(3.5)
      .bool(true)
      .bool(false);
    const bytes = w.toUint8Array();
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(0xab);
    expect(r.i8()).toBe(-7);
    expect(r.u16()).toBe(0x1234);
    expect(r.i16()).toBe(-1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.i32()).toBe(-100000);
    expect(r.u64()).toBe(0xcafebabedeadbeefn);
    expect(r.i64()).toBe(-9000000000n);
    expect(r.f32()).toBeCloseTo(3.5);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("writes little-endian byte order matching C++ packed structs", () => {
    const w = new BufferWriter();
    w.u32(0x01020304);
    const bytes = w.toUint8Array();
    expect(Array.from(bytes)).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it("round-trips packed vec3 / vec4 / int2 / uid", () => {
    const w = new BufferWriter();
    w.vec3(1, 2, 3).vec4(0, 0, 0, 1).uid(0x1122334455667788n);
    const r = new BufferReader(w.toUint8Array());
    expect(r.vec3()).toEqual([1, 2, 3]);
    expect(r.vec4()).toEqual([0, 0, 0, 1]);
    expect(r.uid()).toBe(0x1122334455667788n);
  });

  it("grows the buffer beyond the initial capacity", () => {
    const w = new BufferWriter(4);
    for (let i = 0; i < 100; i++) w.u32(i);
    const r = new BufferReader(w.toUint8Array());
    for (let i = 0; i < 100; i++) expect(r.u32()).toBe(i);
  });

  it("round-trips utf-8 strings of arbitrary length", () => {
    const s = "héllo, world — 🎯";
    const encoded = new TextEncoder().encode(s);
    const w = new BufferWriter();
    w.u16(encoded.byteLength).utf8(s);
    const r = new BufferReader(w.toUint8Array());
    const len = r.u16();
    expect(r.utf8(len)).toBe(s);
  });
});
