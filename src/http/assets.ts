// Fetches HTTP(S) assets referenced by TexturePointer / MeshPointer chunks.
// Keeps an in-memory cache keyed by absolute URL; concurrent requests for the
// same URL share a single fetch(). The response's Content-Type is captured
// alongside the bytes so callers (fetchPointer) can dispatch by MIME.
//
// IndexedDB persistence is intentionally not wired up here. The protocol's
// HTTP layer expects the server to set its own caching headers and the browser
// HTTP cache covers reload behaviour; adding a parallel IndexedDB tier without
// a clear cache-invalidation story would just hide stale data.

export interface AssetFetcherOptions {
  /** Prepended when a chunk URL is not absolute (no scheme). */
  defaultUrlRoot?: string;
  /** Override for unit tests. */
  fetcher?: typeof fetch;
}

/** The result of an `AssetFetcher.get(url)` call. */
export interface FetchedAsset {
  /** Resolved absolute URL (after `defaultUrlRoot` expansion). */
  url: string;
  /** Response body bytes. */
  bytes: Uint8Array;
  /** Lower-cased base MIME type with any `;charset=…` parameter stripped,
   *  or `null` if the response had no Content-Type. */
  mime: string | null;
}

export class AssetFetcher {
  private readonly defaultUrlRoot: string;
  private readonly fetcher: typeof fetch;
  private readonly cache = new Map<string, FetchedAsset>();
  private readonly inFlight = new Map<string, Promise<FetchedAsset>>();

  constructor(opts: AssetFetcherOptions = {}) {
    this.defaultUrlRoot = opts.defaultUrlRoot ?? "";
    this.fetcher = opts.fetcher ?? fetch.bind(globalThis);
  }

  resolveUrl(url: string): string {
    if (/^[a-z]+:\/\//i.test(url)) return url;
    if (!this.defaultUrlRoot) return url;
    const root = this.defaultUrlRoot.replace(/\/+$/, "");
    const tail = url.replace(/^\/+/, "");
    return `${root}/${tail}`;
  }

  /** Fetch the body for `url`. Returns the cached copy if available. */
  async get(url: string): Promise<FetchedAsset> {
    const resolved = this.resolveUrl(url);
    const cached = this.cache.get(resolved);
    if (cached) return cached;
    const pending = this.inFlight.get(resolved);
    if (pending) return pending;
    const p = this.fetchOnce(resolved);
    this.inFlight.set(resolved, p);
    try {
      const asset = await p;
      this.cache.set(resolved, asset);
      return asset;
    } finally {
      this.inFlight.delete(resolved);
    }
  }

  private async fetchOnce(url: string): Promise<FetchedAsset> {
    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const mime = normaliseContentType(res.headers.get("content-type"));
    return { url, bytes, mime };
  }

  /** Drop a URL from the cache. Used after a ResourceLost re-request. */
  invalidate(url: string): void {
    this.cache.delete(this.resolveUrl(url));
  }

  /** Clear everything; used on session close. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

function normaliseContentType(raw: string | null): string | null {
  if (!raw) return null;
  const semi = raw.indexOf(";");
  const base = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  return base || null;
}
