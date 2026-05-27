// Samples /proc/<pid>/{stat,status} for an external server process. All
// values returned are cumulative; the aggregator computes deltas between
// successive samples for rates.
//
// CPU times are reported in seconds. The conversion assumes the kernel's
// USER_HZ is 100 (true on every standard Linux distribution since the
// 2.6 days). Node has no portable way to query sysconf(_SC_CLK_TCK), so
// this is hard-coded and flagged here.

import { readFileSync } from "node:fs";

const USER_HZ = 100;

export class ServerSampler {
  /**
   * @param {number} pid  process id of the server to sample
   */
  constructor(pid) {
    this.pid = pid;
    this.lastError = null;
  }

  /** Read a single sample. Returns null on error (process gone, etc.). */
  sample() {
    try {
      return {
        ts_ms: Date.now(),
        ...this._readStat(),
        ...this._readStatus(),
      };
    } catch (err) {
      this.lastError = err?.message ?? String(err);
      return null;
    }
  }

  _readStat() {
    // /proc/<pid>/stat is space-separated, but field 2 (comm) is in
    // parentheses and may itself contain spaces. Strip everything up to
    // the last ")" then split the remainder.
    const raw = readFileSync(`/proc/${this.pid}/stat`, "utf8");
    const tail = raw.slice(raw.lastIndexOf(")") + 2);
    const f = tail.split(" ");
    // After the (comm) prefix, indexing is shifted: field 3 in the
    // proc(5) docs becomes f[0] here, so utime (field 14) -> f[11],
    // stime (15) -> f[12], num_threads (20) -> f[17].
    return {
      cpu_user_s: Number(f[11]) / USER_HZ,
      cpu_sys_s: Number(f[12]) / USER_HZ,
      threads: Number(f[17]),
    };
  }

  _readStatus() {
    const raw = readFileSync(`/proc/${this.pid}/status`, "utf8");
    const out = { rss_kb: 0, vsize_kb: 0 };
    for (const line of raw.split("\n")) {
      if (line.startsWith("VmRSS:")) out.rss_kb = parseInt(line.split(/\s+/)[1], 10);
      else if (line.startsWith("VmSize:")) out.vsize_kb = parseInt(line.split(/\s+/)[1], 10);
    }
    return out;
  }
}
