// JSON + CSV serialisers for the run report and per-second series.

import { writeFileSync } from "node:fs";

/** Write the full run report (per-client snapshots + per-second series) as
 *  pretty-printed JSON. */
export function writeJson(path, report) {
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/** Write the per-second series as CSV. Column order is derived from the
 *  first row and held stable for the rest; missing keys are written as
 *  empty cells. Strings are quoted when they contain a comma or quote. */
export function writeCsv(path, rows) {
  if (!rows || rows.length === 0) {
    writeFileSync(path, "");
    return;
  }
  const cols = Object.keys(rows[0]);
  const out = [cols.join(",")];
  for (const row of rows) {
    out.push(cols.map((c) => csvCell(row[c])).join(","));
  }
  writeFileSync(path, out.join("\n") + "\n");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
