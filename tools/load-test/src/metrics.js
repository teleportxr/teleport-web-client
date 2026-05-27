// Tiny no-dependency Histogram with log-spaced buckets covering ~10us to 10min.
// Stores raw observations up to a cap so the runner can emit exact p50/p95/p99
// at the end of a run; once the cap is reached new observations only update
// the bucket counters and min/max, not the reservoir.

const BUCKET_EDGES_MS = (() => {
  // 1.0, 1.25, 1.6, 2.0, 2.5, ... up to ~600000ms (10 min), log10 spaced.
  const out = [];
  const mantissas = [1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.4, 8.0];
  for (let exp = -2; exp <= 6; exp++) {
    const scale = Math.pow(10, exp);
    for (const m of mantissas) out.push(m * scale);
  }
  return out;
})();

export class Histogram {
  constructor(reservoirCap = 4096) {
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.buckets = new Uint32Array(BUCKET_EDGES_MS.length + 1);
    this.reservoir = []; // raw observations, capped
    this.reservoirCap = reservoirCap;
  }

  observe(ms) {
    if (!Number.isFinite(ms)) return;
    this.count += 1;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
    // Binary search for the first bucket edge >= ms.
    let lo = 0,
      hi = BUCKET_EDGES_MS.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (BUCKET_EDGES_MS[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    this.buckets[lo] += 1;
    if (this.reservoir.length < this.reservoirCap) this.reservoir.push(ms);
  }

  /** Return {p50, p95, p99} from the reservoir. NaN if empty. */
  percentiles() {
    if (this.reservoir.length === 0)
      return { p50: NaN, p95: NaN, p99: NaN };
    const sorted = this.reservoir.slice().sort((a, b) => a - b);
    const pick = (q) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
  }

  summary() {
    const { p50, p95, p99 } = this.percentiles();
    return {
      count: this.count,
      min_ms: this.count ? this.min : 0,
      max_ms: this.count ? this.max : 0,
      mean_ms: this.count ? this.sum / this.count : 0,
      p50_ms: p50,
      p95_ms: p95,
      p99_ms: p99,
    };
  }
}
