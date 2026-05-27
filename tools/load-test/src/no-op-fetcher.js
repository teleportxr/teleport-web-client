// Stand-in for AssetFetcher used by `--assets off`. Resolves every request
// to a small empty buffer immediately so TeleportClient.fetchPointer can
// still ack the uid through its normal path. Counts call/byte totals so the
// HeadlessClient can report how many fetches were elided.
//
// The TeleportClient only depends on the duck-typed surface:
//   - get(url) -> Promise<{ url, bytes, mime }>
//   - clear()
// so we don't need to inherit from the real AssetFetcher class.

const EMPTY_BYTES = new Uint8Array(0);

export class NoOpFetcher {
  constructor() {
    this.calls = 0;
    this.skippedBytes = 0; // always 0 — kept for symmetry with future modes
  }

  async get(url) {
    this.calls += 1;
    return { url, bytes: EMPTY_BYTES, mime: null };
  }

  clear() {
    // nothing cached
  }
}
