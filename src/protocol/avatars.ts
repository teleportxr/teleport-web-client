// JSON codecs and shared types for the avatar-negotiation signaling
// messages. Wire format mirrors Teleport/TeleportCore/Avatars.h and
// teleport-nodejs/protocol/avatars.js, and is documented in
// Teleport/docs/protocol/signaling.rst.
//
// All values are designed to round-trip JSON.parse/JSON.stringify
// losslessly; uids are represented as `string` on the wire and parsed
// to `bigint` in JS-land.

export const AVATAR_SIGNAL_TYPES = {
  POLICY: "avatar-policy",
  OFFER: "avatar-offer",
  RESULT: "avatar-result",
  REVOKE: "avatar-revoke",
  PEER_AVATAR: "peer-avatar",
  PEER_AVATAR_FAILED: "peer-avatar-failed",
} as const;

// SignalingCapabilities -------------------------------------------------
// Free-form capability bag advertised on the `connect` envelope. Unknown
// keys MUST be ignored on read; only first-class flags are written.

export interface SignalingCapabilities {
  /** Client can fetch peer avatars directly from their host (relay mode). */
  avatar_relay: boolean;
}

export function decodeCapabilities(raw: unknown): SignalingCapabilities {
  const out: SignalingCapabilities = { avatar_relay: false };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.avatar_relay === "boolean") out.avatar_relay = r.avatar_relay;
  }
  return out;
}

export function encodeCapabilities(c: Partial<SignalingCapabilities>): SignalingCapabilities {
  return { avatar_relay: !!c.avatar_relay };
}

// Avatar messages -------------------------------------------------------

export interface AvatarRequirements {
  formats?: string[];
  max_file_bytes?: number;
  max_triangles?: number;
  max_height_m?: number;
  max_width_m?: number;
  max_textures?: number;
  max_texture_pixels?: number;
  skeleton?: string;
  licence_tags_allowed?: string[];
  /** Free-form bag — unknown keys preserved verbatim. */
  [k: string]: unknown;
}

export interface AvatarProofPolicy {
  required: boolean;
  accepted_schemes?: string[];
}

export interface AvatarProofOffer {
  scheme: string;
  value: string;
}

export interface AvatarDeclared {
  format: string;
  file_bytes?: number;
  triangles?: number;
}

export interface AvatarPolicy {
  policy_id: bigint;
  requirement: "required" | "optional" | "forbidden";
  default_available: boolean;
  requirements: AvatarRequirements;
  proof: AvatarProofPolicy;
  fetch_timeout_ms?: number;
}

export interface AvatarOffer {
  policy_id: bigint;
  have_avatar: boolean;
  url?: string;
  content_hash?: string;
  declared?: AvatarDeclared;
  proof?: AvatarProofOffer;
  allow_relay?: boolean;
}

export interface AvatarResult {
  policy_id: bigint;
  status: "accepted" | "rejected" | "pending";
  node_uid: bigint;
  using_default: boolean;
  delivery: "import" | "relay";
  reasons: string[];
}

export interface AvatarRevoke {
  policy_id: bigint;
  reason: string;
}

export interface PeerAvatar {
  peer_client_id: bigint;
  peer_node_uid: bigint;
  url?: string;
  content_hash?: string;
  format?: string;
  proof?: AvatarProofOffer;
  revoked: boolean;
}

export interface PeerAvatarFailed {
  peer_node_uid: bigint;
  reason: string;
}

// Parsers / encoders. Each pair takes the structurally-typed JSON form
// and produces the strongly-typed object above (parsers) or vice versa
// (encoders). uids cross the wire as `string` to survive JSON's 53-bit
// integer ceiling.

const toBig = (v: unknown): bigint =>
  typeof v === "bigint" ? v : v == null ? 0n : BigInt(v as number | string);
const fromBig = (v: bigint | number | string): string =>
  typeof v === "bigint" ? v.toString() : String(v);

export function parseAvatarPolicy(j: any): AvatarPolicy {
  return {
    policy_id: toBig(j?.policy_id),
    requirement: (j?.requirement as AvatarPolicy["requirement"]) ?? "optional",
    default_available: !!j?.default_available,
    requirements: (j?.requirements ?? {}) as AvatarRequirements,
    proof: {
      required: !!j?.proof?.required,
      accepted_schemes: Array.isArray(j?.proof?.accepted_schemes)
        ? [...j.proof.accepted_schemes]
        : [],
    },
    ...(j?.fetch_timeout_ms != null ? { fetch_timeout_ms: Number(j.fetch_timeout_ms) } : {}),
  };
}

export function encodeAvatarOffer(o: AvatarOffer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    policy_id: fromBig(o.policy_id),
    have_avatar: !!o.have_avatar,
  };
  if (o.url != null) out.url = o.url;
  if (o.content_hash != null) out.content_hash = o.content_hash;
  if (o.declared) out.declared = { ...o.declared };
  if (o.proof) out.proof = { ...o.proof };
  if (o.allow_relay != null) out.allow_relay = !!o.allow_relay;
  return out;
}

export function parseAvatarResult(j: any): AvatarResult {
  return {
    policy_id: toBig(j?.policy_id),
    status: (j?.status as AvatarResult["status"]) ?? "rejected",
    node_uid: toBig(j?.node_uid),
    using_default: !!j?.using_default,
    delivery: (j?.delivery as AvatarResult["delivery"]) ?? "import",
    reasons: Array.isArray(j?.reasons) ? [...j.reasons] : [],
  };
}

export function parseAvatarRevoke(j: any): AvatarRevoke {
  return { policy_id: toBig(j?.policy_id), reason: String(j?.reason ?? "") };
}

export function parsePeerAvatar(j: any): PeerAvatar {
  const out: PeerAvatar = {
    peer_client_id: toBig(j?.peer_client_id),
    peer_node_uid: toBig(j?.peer_node_uid),
    revoked: !!j?.revoked,
  };
  if (j?.url != null) out.url = String(j.url);
  if (j?.content_hash != null) out.content_hash = String(j.content_hash);
  if (j?.format != null) out.format = String(j.format);
  if (j?.proof && typeof j.proof === "object")
    out.proof = { scheme: String(j.proof.scheme ?? ""), value: String(j.proof.value ?? "") };
  return out;
}

export function encodePeerAvatarFailed(f: PeerAvatarFailed): Record<string, unknown> {
  return { peer_node_uid: fromBig(f.peer_node_uid), reason: f.reason };
}
