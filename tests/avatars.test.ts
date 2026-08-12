// Round-trip tests for the avatar-negotiation codecs in protocol/avatars.ts.
// Mirrors Teleport/test/test_avatars.cpp and teleport-nodejs/test/test_avatars.js.

import { describe, expect, it } from "vitest";
import {
  decodeCapabilities,
  encodeCapabilities,
  parseAvatarPolicy,
  encodeAvatarOffer,
  parseAvatarResult,
  parseAvatarRevoke,
  AVATAR_SIGNAL_TYPES,
  type AvatarOffer,
} from "../src/protocol/avatars.js";
import * as avatarsModule from "../src/protocol/avatars.js";
import { SignalingClient } from "../src/transport/signaling.js";

describe("SignalingCapabilities", () => {
  // No capabilities are defined: the bag is an extension point only.
  // Avatars deliberately need none — an avatar arrives as an ordinary mesh
  // pointer, which every client can already fetch.
  it("decodes any input to an empty bag", () => {
    expect(decodeCapabilities(undefined)).toEqual({});
    expect(decodeCapabilities(null)).toEqual({});
    expect(decodeCapabilities({})).toEqual({});
    expect(decodeCapabilities([1, 2, 3])).toEqual({});
  });

  it("ignores unknown keys rather than failing on them", () => {
    expect(decodeCapabilities({ future_flag: 7, avatar_relay: true })).toEqual({});
  });

  it("encodes to an empty bag", () => {
    expect(encodeCapabilities({})).toEqual({});
  });
});

describe("peer-facing avatar messages", () => {
  // A client is only told about its own avatar; another client's arrives as
  // ordinary geometry (plans/avatars_plan.md §2.2). Guards against the
  // deleted peer-avatar codecs creeping back in.
  it("do not exist", () => {
    for (const name of [
      "parsePeerAvatar",
      "encodePeerAvatar",
      "parsePeerAvatarFailed",
      "encodePeerAvatarFailed",
    ])
      expect(name in avatarsModule).toBe(false);
    expect(Object.values(AVATAR_SIGNAL_TYPES)).toEqual([
      "avatar-policy",
      "avatar-offer",
      "avatar-result",
      "avatar-revoke",
    ]);
  });
});

describe("AvatarPolicy", () => {
  it("round-trips through JSON without losing first-class fields", () => {
    const wire = {
      policy_id: "12345",
      requirement: "required" as const,
      default_available: true,
      requirements: {
        formats: ["glb", "vrm"],
        max_file_bytes: 8 * 1024 * 1024,
        max_triangles: 60000,
        skeleton: "humanoid",
        licence_tags_allowed: ["CC0", "CC-BY"],
      },
      proof: { required: true, accepted_schemes: ["jws-detached"] },
      fetch_timeout_ms: 7500,
    };
    const p = parseAvatarPolicy(JSON.parse(JSON.stringify(wire)));
    expect(p.policy_id).toBe(12345n);
    expect(p.requirement).toBe("required");
    expect(p.default_available).toBe(true);
    expect(p.requirements.formats).toEqual(["glb", "vrm"]);
    expect(p.requirements.licence_tags_allowed).toEqual(["CC0", "CC-BY"]);
    expect(p.proof.required).toBe(true);
    expect(p.proof.accepted_schemes).toEqual(["jws-detached"]);
    expect(p.fetch_timeout_ms).toBe(7500);
  });

  it("returns sensible defaults for an empty object", () => {
    const p = parseAvatarPolicy({});
    expect(p.policy_id).toBe(0n);
    expect(p.requirement).toBe("optional");
    expect(p.default_available).toBe(false);
    expect(p.proof.required).toBe(false);
    expect(p.proof.accepted_schemes).toEqual([]);
  });
});

describe("AvatarOffer", () => {
  it("encodes a full offer, including declared + proof + allow_relay", () => {
    const o: AvatarOffer = {
      policy_id: 42n,
      have_avatar: true,
      url: "https://avatars.example.com/u/42.glb",
      content_hash: "sha256:abcd",
      declared: { format: "glb", file_bytes: 4096, triangles: 1200 },
      proof: { scheme: "jws-detached", value: "eyJ..." },
      allow_relay: false,
    };
    const wire = encodeAvatarOffer(o);
    expect(wire.policy_id).toBe("42");
    expect(wire.have_avatar).toBe(true);
    expect(wire.url).toBe(o.url);
    expect(wire.content_hash).toBe(o.content_hash);
    expect(wire.declared).toEqual(o.declared);
    expect(wire.proof).toEqual(o.proof);
    expect(wire.allow_relay).toBe(false);
  });

  it("emits a minimal envelope for have_avatar=false", () => {
    const wire = encodeAvatarOffer({ policy_id: 7n, have_avatar: false });
    expect(wire).toEqual({ policy_id: "7", have_avatar: false });
  });
});

describe("AvatarResult", () => {
  it("parses the server's verdict with relay delivery", () => {
    const r = parseAvatarResult({
      policy_id: "3",
      status: "accepted",
      node_uid: "999",
      using_default: false,
      delivery: "relay",
      reasons: ["ok"],
    });
    expect(r.policy_id).toBe(3n);
    expect(r.status).toBe("accepted");
    expect(r.node_uid).toBe(999n);
    expect(r.delivery).toBe("relay");
    expect(r.reasons).toEqual(["ok"]);
  });
});

describe("AvatarRevoke", () => {
  it("parses a revoke envelope", () => {
    const r = parseAvatarRevoke({ policy_id: "17", reason: "licence_expired" });
    expect(r).toEqual({ policy_id: 17n, reason: "licence_expired" });
  });
});

describe("SignalingClient connect envelope", () => {
  it("includes an empty capabilities object", () => {
    const sc = new SignalingClient("ws://example.invalid/");
    // Reach into the instance without opening a real socket: stub sendJson
    // and verify the connect payload contains the capability bag.
    const sent: unknown[] = [];
    // @ts-expect-error: replace the private sendJson for the duration of the test.
    sc.sendJson = (m: unknown) => sent.push(m);
    sc.sendConnect(0n);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as {
      "teleport-signal-type": string;
      content: { clientID: string; capabilities: Record<string, unknown> };
    };
    expect(msg["teleport-signal-type"]).toBe("connect");
    expect(msg.content.clientID).toBe("0");
    expect(msg.content.capabilities).toEqual({});
  });

  it("does not advertise any avatar capability", () => {
    // Relay is the default and needs no negotiation; advertising a
    // capability we do not act on is what broke the previous design.
    const sc = new SignalingClient("ws://example.invalid/");
    const sent: unknown[] = [];
    // @ts-expect-error: see above.
    sc.sendJson = (m: unknown) => sent.push(m);
    sc.sendConnect(42n);
    const msg = sent[0] as { content: { clientID: string; capabilities: Record<string, unknown> } };
    expect(msg.content.clientID).toBe("42");
    expect(Object.keys(msg.content.capabilities)).toHaveLength(0);
  });
});
