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
  parsePeerAvatar,
  encodePeerAvatarFailed,
  type AvatarOffer,
  type PeerAvatarFailed,
} from "../src/protocol/avatars.js";
import { SignalingClient } from "../src/transport/signaling.js";

describe("SignalingCapabilities", () => {
  it("decodes missing / empty / wrong-type input to all-false defaults", () => {
    expect(decodeCapabilities(undefined)).toEqual({ avatar_relay: false });
    expect(decodeCapabilities(null)).toEqual({ avatar_relay: false });
    expect(decodeCapabilities({})).toEqual({ avatar_relay: false });
    expect(decodeCapabilities([1, 2, 3])).toEqual({ avatar_relay: false });
    expect(decodeCapabilities({ avatar_relay: "yes" })).toEqual({ avatar_relay: false });
  });

  it("decodes avatar_relay and ignores future unknown keys", () => {
    const c = decodeCapabilities({ avatar_relay: true, future_flag: 7 });
    expect(c.avatar_relay).toBe(true);
    expect("future_flag" in c).toBe(false);
  });

  it("encodes only first-class keys and coerces to boolean", () => {
    expect(encodeCapabilities({ avatar_relay: true })).toEqual({ avatar_relay: true });
    expect(encodeCapabilities({})).toEqual({ avatar_relay: false });
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

describe("AvatarRevoke / PeerAvatar / PeerAvatarFailed", () => {
  it("parses a revoke envelope", () => {
    const r = parseAvatarRevoke({ policy_id: "17", reason: "licence_expired" });
    expect(r).toEqual({ policy_id: 17n, reason: "licence_expired" });
  });

  it("parses a peer-avatar envelope including proof", () => {
    const p = parsePeerAvatar({
      peer_client_id: "100",
      peer_node_uid: "200",
      url: "https://example.com/a.glb",
      content_hash: "sha256:ff",
      format: "glb",
      proof: { scheme: "well-known-url", value: "https://example.com/.well-known/avatar-binding" },
      revoked: false,
    });
    expect(p.peer_client_id).toBe(100n);
    expect(p.peer_node_uid).toBe(200n);
    expect(p.url).toBe("https://example.com/a.glb");
    expect(p.proof?.scheme).toBe("well-known-url");
  });

  it("encodes peer-avatar-failed with reason", () => {
    const f: PeerAvatarFailed = { peer_node_uid: 200n, reason: "404" };
    expect(encodePeerAvatarFailed(f)).toEqual({ peer_node_uid: "200", reason: "404" });
  });
});

describe("SignalingClient connect envelope", () => {
  it("includes a capabilities object defaulting to avatar_relay=true", async () => {
    const sc = new SignalingClient("ws://example.invalid/");
    // Reach into the instance without opening a real socket: stub sendJson
    // and verify the connect payload contains the capability bag.
    const sent: unknown[] = [];
    // @ts-expect-error: replace the private sendJson for the duration of the test.
    sc.sendJson = (m: unknown) => sent.push(m);
    sc.sendConnect(0n);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as { "teleport-signal-type": string; content: { clientID: string; capabilities: { avatar_relay: boolean } } };
    expect(msg["teleport-signal-type"]).toBe("connect");
    expect(msg.content.clientID).toBe("0");
    expect(msg.content.capabilities).toEqual({ avatar_relay: true });
  });

  it("respects an override of capabilities.avatar_relay=false", () => {
    const sc = new SignalingClient("ws://example.invalid/");
    sc.capabilities = { avatar_relay: false };
    const sent: unknown[] = [];
    // @ts-expect-error: see above.
    sc.sendJson = (m: unknown) => sent.push(m);
    sc.sendConnect(42n);
    const msg = sent[0] as { content: { clientID: string; capabilities: { avatar_relay: boolean } } };
    expect(msg.content.clientID).toBe("42");
    expect(msg.content.capabilities.avatar_relay).toBe(false);
  });
});
