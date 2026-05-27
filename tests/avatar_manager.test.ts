// Behavioural tests for AvatarManager. Mirrors
// Teleport/test/test_avatar_manager.cpp.

import { describe, expect, it } from "vitest";
import { AvatarManager } from "../src/avatar_manager.js";
import {
  type AvatarOffer,
  type AvatarPolicy,
  type AvatarResult,
} from "../src/protocol/avatars.js";

function policyEnvelope(policyId: bigint): string {
  return JSON.stringify({
    "teleport-signal-type": "avatar-policy",
    content: {
      policy_id: policyId.toString(),
      requirement: "optional",
      default_available: true,
      requirements: { formats: ["glb"] },
      proof: { required: false, accepted_schemes: [] },
    },
  });
}

function resultEnvelope(policyId: bigint, status: AvatarResult["status"] | "using_default"): string {
  return JSON.stringify({
    "teleport-signal-type": "avatar-result",
    content: {
      policy_id: policyId.toString(),
      status,
      node_uid: "0",
      using_default: status === "using_default",
      delivery: "import",
      reasons: [],
    },
  });
}

function revokeEnvelope(policyId: bigint, reason: string): string {
  return JSON.stringify({
    "teleport-signal-type": "avatar-revoke",
    content: { policy_id: policyId.toString(), reason },
  });
}

describe("AvatarManager", () => {
  it("default callback replies have_avatar=false", () => {
    const sent: unknown[] = [];
    const mgr = new AvatarManager((raw) => sent.push(JSON.parse(raw)));

    expect(mgr.handleSignalingMessage(policyEnvelope(7n))).toBe(true);

    expect(sent).toHaveLength(1);
    const frame = sent[0] as { "teleport-signal-type": string; content: { policy_id: string; have_avatar: boolean } };
    expect(frame["teleport-signal-type"]).toBe("avatar-offer");
    expect(frame.content.policy_id).toBe("7");
    expect(frame.content.have_avatar).toBe(false);
    expect(mgr.hasCurrentPolicy).toBe(true);
    expect(mgr.currentPolicy?.policy_id).toBe(7n);
  });

  it("host-supplied callback receives policy and can reply with a full offer", () => {
    const sent: unknown[] = [];
    const mgr = new AvatarManager((raw) => sent.push(JSON.parse(raw)));

    let captured: AvatarPolicy | null = null;
    mgr.setOnAvatarPolicy((policy, reply) => {
      captured = policy;
      const offer: AvatarOffer = {
        policy_id: policy.policy_id,
        have_avatar: true,
        url: "https://avatars.example/u/1.glb",
        allow_relay: true,
      };
      reply(offer);
    });

    expect(mgr.handleSignalingMessage(policyEnvelope(42n))).toBe(true);

    expect(captured).not.toBeNull();
    expect(captured!.policy_id).toBe(42n);
    expect(sent).toHaveLength(1);
    const content = (sent[0] as { content: Record<string, unknown> }).content;
    expect(content.have_avatar).toBe(true);
    expect(content.url).toBe("https://avatars.example/u/1.glb");
    expect(content.allow_relay).toBe(true);
  });

  it("falls back to default offer when host callback throws", () => {
    const sent: unknown[] = [];
    const mgr = new AvatarManager((raw) => sent.push(JSON.parse(raw)));
    mgr.setOnAvatarPolicy(() => { throw new Error("boom"); });

    expect(mgr.handleSignalingMessage(policyEnvelope(7n))).toBe(true);
    expect(sent).toHaveLength(1);
    const content = (sent[0] as { content: Record<string, unknown> }).content;
    expect(content.policy_id).toBe("7");
    expect(content.have_avatar).toBe(false);
  });

  it("parses avatar-result and caches it", () => {
    const mgr = new AvatarManager(() => {});
    let observed: AvatarResult | null = null;
    mgr.setOnAvatarResult((r) => { observed = r; });

    expect(mgr.handleSignalingMessage(resultEnvelope(11n, "using_default"))).toBe(true);

    expect(observed).not.toBeNull();
    expect(observed!.policy_id).toBe(11n);
    expect(observed!.status).toBe("using_default");
    expect(observed!.using_default).toBe(true);
    expect(mgr.lastResult?.status).toBe("using_default");
  });

  it("handles avatar-revoke by clearing cached state", () => {
    const mgr = new AvatarManager(() => {});
    expect(mgr.handleSignalingMessage(policyEnvelope(7n))).toBe(true);
    expect(mgr.handleSignalingMessage(resultEnvelope(7n, "using_default"))).toBe(true);
    expect(mgr.hasCurrentPolicy).toBe(true);

    expect(mgr.handleSignalingMessage(revokeEnvelope(7n, "licence_expired"))).toBe(true);

    expect(mgr.hasCurrentPolicy).toBe(false);
    expect(mgr.lastOffer).toBeNull();
    expect(mgr.lastResult).toBeNull();
  });

  it("ignores non-avatar signaling frames and malformed input", () => {
    const sent: unknown[] = [];
    const mgr = new AvatarManager((raw) => sent.push(raw));

    expect(mgr.handleSignalingMessage(JSON.stringify({
      "teleport-signal-type": "something-else", content: {},
    }))).toBe(false);
    expect(mgr.handleSignalingMessage("not json at all")).toBe(false);
    expect(mgr.handleSignalingMessage(JSON.stringify({ no_type: 1 }))).toBe(false);
    expect(sent).toEqual([]);
  });

  it("provideAvatar sends an avatar-offer envelope", () => {
    const sent: unknown[] = [];
    const mgr = new AvatarManager((raw) => sent.push(JSON.parse(raw)));

    mgr.provideAvatar({ policy_id: 99n, have_avatar: true, url: "https://x/a.glb" });

    expect(sent).toHaveLength(1);
    const frame = sent[0] as { "teleport-signal-type": string; content: { policy_id: string; have_avatar: boolean; url?: string } };
    expect(frame["teleport-signal-type"]).toBe("avatar-offer");
    expect(frame.content.policy_id).toBe("99");
    expect(frame.content.have_avatar).toBe(true);
    expect(frame.content.url).toBe("https://x/a.glb");
    expect(mgr.lastOffer?.policy_id).toBe(99n);
  });
});
