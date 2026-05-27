// Teleport URL helpers.
//
// The signalling server accepts a WebSocket URL (ws:// or wss://). Operators
// hand out `teleport://` URLs as a friendlier scheme; we normalise them here
// so callers (the Web Component, examples) can pass either form.
//
// Scheme rules:
//   * `teleport://`   — secure by default (wss), downgraded to ws only when
//                       the host is a loopback / private-network address.
//   * `teleports://`  — always wss, even against loopback / private hosts
//                       (use this to force TLS during local TLS-proxy testing).
//   * `ws://` / `wss://`  — passed through unchanged.
//   * `http://` / `https://` — mapped to ws / wss respectively.

export interface ParsedTeleportUrl {
  /** Lower-cased scheme of the input URL. */
  scheme: string;
  /** Hostname only, without port. */
  host: string;
  /** Port number, or `null` if absent. */
  port: number | null;
  /** Path component, including any leading "/", or "" if absent. */
  path: string;
  /** True when the input scheme implies TLS (teleports / wss / https). */
  secure: boolean;
}

const SCHEME_RE = /^([a-z][a-z0-9+.\-]*):\/\/(.+)$/i;

export function parseTeleportUrl(url: string): ParsedTeleportUrl {
  const m = SCHEME_RE.exec(url.trim());
  if (!m) throw new Error(`unrecognised teleport URL: ${url}`);
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  // Bracketed IPv6: [::1]:8081
  let host: string;
  let portStr: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) throw new Error(`invalid bracketed IPv6 host: ${url}`);
    host = authority.slice(1, close);
    portStr = authority.slice(close + 1).replace(/^:/, "");
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon === -1) {
      host = authority;
      portStr = "";
    } else {
      host = authority.slice(0, colon);
      portStr = authority.slice(colon + 1);
    }
  }
  const port = portStr ? Number(portStr) : null;
  const secure = scheme === "teleports" || scheme === "wss" || scheme === "https";
  return { scheme, host, port, path, secure };
}

/** True for hostnames that resolve to a loopback or private-network address. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.endsWith(".local") || h.endsWith(".localhost")) return true;
  // IPv6 link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return true;
  // IPv4 dotted-quad checks.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  return false;
}

/** Convert any teleport-flavoured URL into a ws://-style URL suitable for `new WebSocket(...)`. */
export function normalizeSignalingUrl(url: string): string {
  const parsed = parseTeleportUrl(url);
  const proto = chooseWebSocketScheme(parsed);
  const port = parsed.port !== null ? `:${parsed.port}` : "";
  const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
  const path = parsed.path || "/";
  return `${proto}://${host}${port}${path}`;
}

function chooseWebSocketScheme(parsed: ParsedTeleportUrl): "ws" | "wss" {
  switch (parsed.scheme) {
    case "ws":
    case "http":
      return "ws";
    case "wss":
    case "https":
    case "teleports":
      return "wss";
    case "teleport":
      // Secure by default; downgrade only for loopback / RFC1918 hosts so
      // local development against `teleport://localhost:8081` "just works".
      return isLocalHost(parsed.host) ? "ws" : "wss";
    default:
      throw new Error(`unsupported URL scheme for signalling: ${parsed.scheme}`);
  }
}
