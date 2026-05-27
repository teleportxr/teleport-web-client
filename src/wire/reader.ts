// Little-endian DataView wrapper for parsing packed structs from the wire.

export class BufferReader {
  readonly view: DataView;
  offset: number;

  constructor(buffer: ArrayBuffer | ArrayBufferView, offset = 0) {
    if (buffer instanceof ArrayBuffer) {
      this.view = new DataView(buffer);
    } else {
      this.view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
    }
    this.offset = offset;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  /** Read an avs::uid (uint64) as a bigint. */
  uid(): bigint {
    return this.u64();
  }

  /** Read a packed vec3 (three little-endian floats). */
  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }

  /** Read a packed vec4 (four little-endian floats). */
  vec4(): [number, number, number, number] {
    return [this.f32(), this.f32(), this.f32(), this.f32()];
  }

  /** Read a packed int2 (two little-endian int32s). */
  int2(): [number, number] {
    return [this.i32(), this.i32()];
  }

  /** Read `length` bytes as a Uint8Array view (no copy). */
  bytes(length: number): Uint8Array {
    const v = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.offset,
      length,
    );
    this.offset += length;
    return v;
  }

  /** Read a UTF-8 string of exactly `length` bytes. */
  utf8(length: number): string {
    const slice = this.bytes(length);
    return new TextDecoder("utf-8").decode(slice);
  }

  /** Read a uint16-length-prefixed UTF-8 string (the protocol-wide convention). */
  string(): string {
    const length = this.u16();
    return length > 0 ? this.utf8(length) : "";
  }

  /** Skip `count` bytes. */
  skip(count: number): void {
    this.offset += count;
  }
}
