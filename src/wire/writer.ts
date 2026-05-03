// Little-endian DataView wrapper for building packed structs for the wire.
// Grows the underlying buffer as needed.

export class BufferWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  offset: number;

  constructor(initialCapacity = 64) {
    this.buffer = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.offset = 0;
  }

  private ensure(needed: number): void {
    const required = this.offset + needed;
    if (required <= this.buffer.byteLength) return;
    let newSize = this.buffer.byteLength * 2;
    while (newSize < required) newSize *= 2;
    const next = new ArrayBuffer(newSize);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buffer = next;
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
    return this;
  }

  u64(v: bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.offset, v, true);
    this.offset += 8;
    return this;
  }

  i64(v: bigint): this {
    this.ensure(8);
    this.view.setBigInt64(this.offset, v, true);
    this.offset += 8;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  uid(v: bigint): this {
    return this.u64(v);
  }

  vec3(x: number, y: number, z: number): this {
    return this.f32(x).f32(y).f32(z);
  }

  vec4(x: number, y: number, z: number, w: number): this {
    return this.f32(x).f32(y).f32(z).f32(w);
  }

  raw(src: Uint8Array): this {
    this.ensure(src.byteLength);
    this.bytes.set(src, this.offset);
    this.offset += src.byteLength;
    return this;
  }

  utf8(s: string): this {
    return this.raw(new TextEncoder().encode(s));
  }

  /** Return a copy of the bytes written so far. */
  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }

  /** Return a view of the bytes written so far (no copy; valid until next write). */
  view_(): Uint8Array {
    return this.bytes.subarray(0, this.offset);
  }
}
