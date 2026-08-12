// Per-server client-side state for avatar negotiation. Mirror of
// teleport::client::AvatarManager (Teleport/TeleportClient/AvatarManager.h)
// and teleport-nodejs server-side avatar_service.js. Phase 2 of the
// implementation in plans/avatars_implementation.md: receive an
// avatar-policy, hand it to the host application's callback, send back an
// avatar-offer.
//
// One AvatarManager is owned by each TeleportClient. Incoming
// `avatar-policy`, `avatar-result` and `avatar-revoke` JSON text frames
// are dispatched in from the SignalingClient via handleSignalingMessage.

import {
  AVATAR_SIGNAL_TYPES,
  encodeAvatarOffer,
  parseAvatarPolicy,
  parseAvatarResult,
  parseAvatarRevoke,
  type AvatarOffer,
  type AvatarPolicy,
  type AvatarResult,
  type AvatarRevoke,
} from "./protocol/avatars.js";

/** Reply callback supplied to the host application's PolicyCallback. The
 *  host application calls this with the AvatarOffer it wants to send back
 *  to the server. It may be called synchronously from inside the callback,
 *  or asynchronously later. */
export type AvatarReplyFn = (offer: AvatarOffer) => void;

/** Invoked when an avatar-policy arrives. The host application decides
 *  what to offer and invokes `reply` with the offer. The default
 *  implementation replies with have_avatar=false, which lets the server
 *  fall back to its default avatar (or to reject). */
export type AvatarPolicyCallback = (
  policy: AvatarPolicy,
  reply: AvatarReplyFn,
) => void;

export type AvatarResultCallback = (result: AvatarResult) => void;
export type AvatarRevokeCallback = (revoke: AvatarRevoke) => void;

/** Function the manager uses to send a signaling text frame. Provided
 *  by the owning TeleportClient and routes to SignalingClient. */
export type AvatarSendFn = (raw: string) => void;

function envelope(type: string, content: unknown): string {
  return JSON.stringify({ "teleport-signal-type": type, content });
}

function defaultPolicyCallback(policy: AvatarPolicy, reply: AvatarReplyFn): void {
  reply({ policy_id: policy.policy_id, have_avatar: false });
}

export class AvatarManager {
  private onPolicy: AvatarPolicyCallback = defaultPolicyCallback;
  private onResult: AvatarResultCallback | null = null;
  private onRevoke: AvatarRevokeCallback | null = null;
  private _currentPolicy: AvatarPolicy | null = null;
  private _lastOffer: AvatarOffer | null = null;
  private _lastResult: AvatarResult | null = null;

  constructor(private readonly send: AvatarSendFn) {}

  /** Host-supplied policy handler. Pass null to restore the default
   *  behaviour (have_avatar=false). */
  setOnAvatarPolicy(cb: AvatarPolicyCallback | null): void {
    this.onPolicy = cb ?? defaultPolicyCallback;
  }
  setOnAvatarResult(cb: AvatarResultCallback | null): void {
    this.onResult = cb;
  }
  setOnAvatarRevoke(cb: AvatarRevokeCallback | null): void {
    this.onRevoke = cb;
  }

  /** Dispatch an incoming signalling text frame. Returns true if the
   *  frame was an avatar-* message handled by this manager, false
   *  otherwise (caller should treat it as unhandled). */
  handleSignalingMessage(raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const p = parsed as Record<string, unknown>;
    const type = p["teleport-signal-type"];
    if (typeof type !== "string") return false;
    const content = p.content;
    switch (type) {
      case AVATAR_SIGNAL_TYPES.POLICY:
        this.handlePolicy(content);
        return true;
      case AVATAR_SIGNAL_TYPES.RESULT:
        this.handleResult(content);
        return true;
      case AVATAR_SIGNAL_TYPES.REVOKE:
        this.handleRevoke(content);
        return true;
      default:
        return false;
    }
  }

  /** Send (or re-send) an avatar-offer to the server. Normally invoked
   *  via the reply callback passed to the PolicyCallback, but exposed
   *  publicly so the host application can refresh its offer at any time. */
  provideAvatar(offer: AvatarOffer): void {
    this._lastOffer = offer;
    this.send(envelope(AVATAR_SIGNAL_TYPES.OFFER, encodeAvatarOffer(offer)));
  }

  /** Send an avatar-revoke from this client to the server. */
  sendRevoke(revoke: AvatarRevoke): void {
    this.send(envelope(AVATAR_SIGNAL_TYPES.REVOKE, {
      policy_id: revoke.policy_id.toString(),
      reason: revoke.reason,
    }));
  }

  get hasCurrentPolicy(): boolean { return this._currentPolicy != null; }
  get currentPolicy(): AvatarPolicy | null { return this._currentPolicy; }
  get lastOffer(): AvatarOffer | null { return this._lastOffer; }
  get lastResult(): AvatarResult | null { return this._lastResult; }

  /** Session uid of this client's avatar root node in the server scene
   *  (from the last avatar-result), or 0n before one arrives. The local
   *  view may use it to recognise — and e.g. hide in first person — its
   *  own avatar in the streamed geometry. */
  get avatarNodeUid(): bigint { return this._lastResult?.node_uid ?? 0n; }

  private handlePolicy(content: unknown): void {
    const policy = parseAvatarPolicy(content ?? {});
    this._currentPolicy = policy;
    const reply: AvatarReplyFn = (offer) => this.provideAvatar(offer);
    try {
      this.onPolicy(policy, reply);
    } catch {
      // Host callback threw; fall back to the no-avatar default so the
      // server isn't left waiting indefinitely.
      defaultPolicyCallback(policy, reply);
    }
  }

  private handleResult(content: unknown): void {
    const result = parseAvatarResult(content ?? {});
    this._lastResult = result;
    this.onResult?.(result);
  }

  private handleRevoke(content: unknown): void {
    const revoke = parseAvatarRevoke(content ?? {});
    // Server has withdrawn the policy; drop cached state so any future
    // offer cannot be matched against it.
    this._currentPolicy = null;
    this._lastOffer = null;
    this._lastResult = null;
    this.onRevoke?.(revoke);
  }
}
