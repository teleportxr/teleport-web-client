// Geometry channel decoder. Each chunk on the geometry data channel begins
// with a 1-byte avs::GeometryPayloadType tag (see common_exports.h).
// Phase 3 will fill in mesh/material/node/texture parsing.

import { BufferReader } from "../wire/reader.js";
import { GeometryPayloadType, type Uid } from "../wire/types.js";

export interface GeometryChunk {
  payloadType: GeometryPayloadType;
  body: Uint8Array;
}

/** Strip the 1-byte payload tag and return the remaining body. */
export function classifyGeometryChunk(packet: Uint8Array): GeometryChunk {
  if (packet.byteLength < 1) {
    throw new Error("empty geometry chunk");
  }
  const r = new BufferReader(packet);
  const payloadType = r.u8() as GeometryPayloadType;
  return { payloadType, body: packet.subarray(1) };
}

/** Phase 3 placeholder: parse a RemoveNodes chunk into a list of uids. */
export function parseRemoveNodes(body: Uint8Array): Uid[] {
  const r = new BufferReader(body);
  const count = Number(r.u64());
  const out: Uid[] = [];
  for (let i = 0; i < count; i++) out.push(r.uid());
  return out;
}
