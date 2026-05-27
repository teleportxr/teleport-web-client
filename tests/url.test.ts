// Tests for the teleport:// → ws(s):// normalisation rules.

import { describe, expect, it } from "vitest";
import {
  isLocalHost,
  normalizeSignalingUrl,
  parseTeleportUrl,
} from "../src/url.js";

describe("parseTeleportUrl", () => {
  it("splits scheme/host/port/path", () => {
    const p = parseTeleportUrl("teleport://example.com:1234/scene-a");
    expect(p).toEqual({
      scheme: "teleport",
      host: "example.com",
      port: 1234,
      path: "/scene-a",
      secure: false,
    });
  });

  it("treats teleports as secure", () => {
    expect(parseTeleportUrl("teleports://h").secure).toBe(true);
  });

  it("parses a bracketed IPv6 host with port", () => {
    const p = parseTeleportUrl("teleport://[::1]:8081/");
    expect(p.host).toBe("::1");
    expect(p.port).toBe(8081);
    expect(p.path).toBe("/");
  });
});

describe("isLocalHost", () => {
  it("flags loopback and RFC1918 hosts", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "127.5.6.7",
      "10.0.0.1",
      "192.168.0.5",
      "172.20.0.1",
      "169.254.1.2",
      "::1",
      "fe80::1",
      "device.local",
    ]) {
      expect(isLocalHost(h), h).toBe(true);
    }
  });

  it("does not flag public hosts", () => {
    for (const h of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "2001:db8::1",
      "teleportxr.com",
    ]) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });
});

describe("normalizeSignalingUrl", () => {
  it("uses ws for teleport:// against localhost", () => {
    expect(normalizeSignalingUrl("teleport://localhost:8081")).toBe(
      "ws://localhost:8081/",
    );
  });

  it("uses wss for teleport:// against a public host", () => {
    expect(normalizeSignalingUrl("teleport://example.com")).toBe(
      "wss://example.com/",
    );
  });

  it("uses wss for teleport:// against a public host with a non-443 port", () => {
    expect(normalizeSignalingUrl("teleport://example.com:9000/scene")).toBe(
      "wss://example.com:9000/scene",
    );
  });

  it("forces wss for teleports:// even against a local host", () => {
    expect(normalizeSignalingUrl("teleports://localhost:8443")).toBe(
      "wss://localhost:8443/",
    );
  });

  it("passes ws:// / wss:// through unchanged (modulo trailing /)", () => {
    expect(normalizeSignalingUrl("ws://localhost:8081/")).toBe("ws://localhost:8081/");
    expect(normalizeSignalingUrl("wss://example.com")).toBe("wss://example.com/");
  });

  it("maps http/https to ws/wss", () => {
    expect(normalizeSignalingUrl("http://localhost:8081/")).toBe("ws://localhost:8081/");
    expect(normalizeSignalingUrl("https://example.com/x")).toBe("wss://example.com/x");
  });

  it("preserves the path", () => {
    expect(normalizeSignalingUrl("teleport://example.com/foo/bar")).toBe(
      "wss://example.com/foo/bar",
    );
  });

  it("brackets IPv6 hosts in the emitted URL", () => {
    expect(normalizeSignalingUrl("teleport://[fe80::1]:8081")).toBe(
      "ws://[fe80::1]:8081/",
    );
  });
});
