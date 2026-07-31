// JSON codecs and shared types for the avatar-negotiation signaling
// messages. Wire format mirrors Teleport/TeleportCore/Avatars.h and
// teleport-nodejs/protocol/avatars.js, and is documented in
// Teleport/docs/protocol/signaling.rst.
//
// All values are designed to round-trip JSON.parse/JSON.stringify
// losslessly; uids are represented as `string` on the wire and parsed
// to `bigint` in JS-land.

// Every message here concerns this client's own avatar. There is
// deliberately no peer-facing avatar message: another client's avatar
// arrives as an ordinary node carrying a mesh pointer, through the
// geometry pipeline, and this client is never told it is an avatar
// (plans/avatars_plan.md §2.2).
export const AVATAR_SIGNAL_TYPES = {
  POLICY: "avatar-policy",
  OFFER: "avatar-offer",
  RESULT: "avatar-result",
  REVOKE: "avatar-revoke",
} as const;

// SignalingCapabilities -------------------------------------------------
// Free-form capability bag advertised on the `connect` envelope. It is a
// general signaling-level extension point with no keys defined at
// present — avatars need none, since relay is the default and requires
// no negotiation. Unknown keys are ignored on read and dropped on write.

export type SignalingCapabilities = Record<string, never>;

export function decodeCapabilities(_raw: unknown): SignalingCapabilities {
  return {};
}

export function encodeCapabilities(_c: Partial<SignalingCapabilities>): SignalingCapabilities {
  return {};
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
  /** Defaults to true. False asks the server not to hand this url to other
   *  clients, forcing it to re-host the asset instead. Worth exposing to
   *  the user when the url carries a token. */
  allow_relay?: boolean;
}

export interface AvatarResult {
  policy_id: bigint;
  status: "accepted" | "rejected" | "pending";
  node_uid: bigint;
  using_default: boolean;
  /** "relay" (the default) means peers were given our own url; "import"
   *  means the server re-hosted the asset. Informational — it says nothing
   *  about any other client's avatar. */
  delivery: "relay" | "import";
  reasons: string[];
}

export interface AvatarRevoke {
  policy_id: bigint;
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
    delivery: (j?.delivery as AvatarResult["delivery"]) ?? "relay",
    reasons: Array.isArray(j?.reasons) ? [...j.reasons] : [],
  };
}

export function parseAvatarRevoke(j: any): AvatarRevoke {
  return { policy_id: toBig(j?.policy_id), reason: String(j?.reason ?? "") };
}
