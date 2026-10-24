#!/usr/bin/env node
// Generates the FICTIONAL golden fixtures for the Workflow Evaluator reference workflow (iii),
// "csv-inspection.exceptions": a day's inspection CSV from production line 3 (1,240 rows) with
// exactly 7 out-of-tolerance readings, plus a clean 200-row file. Deterministic (seeded PRNG), so
// re-running reproduces the committed files byte for byte. All data is invented.
//
//   node scripts/eval/gen-csv-inspection-fixture.mjs [outDir]
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "eval/workflows/csv-inspection.exceptions/fixtures");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Characteristics measured on line 3 (fictional part 3-BRK-210, a bracket).
const CHARS = [
  { station: "ST-01", characteristic: "hole_diameter", nominal: 8.0, tol: 0.05, unit: "mm" },
  { station: "ST-02", characteristic: "flange_thickness", nominal: 3.2, tol: 0.08, unit: "mm" },
  { station: "ST-03", characteristic: "bend_angle", nominal: 90.0, tol: 0.5, unit: "deg" },
  { station: "ST-04", characteristic: "overall_length", nominal: 142.0, tol: 0.2, unit: "mm" },
  { station: "ST-05", characteristic: "surface_roughness", nominal: 1.6, tol: 0.4, unit: "um" },
];
const INSPECTORS = ["INS-07", "INS-12", "INS-19"];
const round = (x, dp) => Number(x.toFixed(dp));
const dpOf = (c) => (c.tol < 0.1 ? 3 : 2);

function build({ rows, seed, date, outliers, boundaries }) {
  const r = rng(seed);
  const header = [
    "row_id", "timestamp", "line", "station", "part_no", "serial", "characteristic",
    "nominal", "lower_limit", "upper_limit", "measured", "unit", "inspector",
  ];
  const lines = [header.join(",")];
  const expected = [];
  const start = Date.parse(`${date}T06:00:00+09:00`);
  for (let i = 1; i <= rows; i++) {
    const c = CHARS[(i - 1) % CHARS.length];
    const dp = dpOf(c);
    const lower = round(c.nominal - c.tol, dp);
    const upper = round(c.nominal + c.tol, dp);
    // In-tolerance reading: within ±70% of the tolerance band.
    let measured = round(c.nominal + (r() * 2 - 1) * c.tol * 0.7, dp);
    if (boundaries.includes(i)) {
      // Exactly on a limit: inside (limits are inclusive). Not an exception.
      measured = i % 2 === 0 ? upper : lower;
    }
    const outlier = outliers.find((o) => o.row === i);
    if (outlier) {
      measured = round(outlier.side === "high" ? upper + c.tol * outlier.by : lower - c.tol * outlier.by, dp);
      expected.push({
        rowId: `L3-${date.replaceAll("-", "")}-${String(i).padStart(4, "0")}`,
        characteristic: c.characteristic,
        measured,
        lowerLimit: lower,
        upperLimit: upper,
        unit: c.unit,
        deviation: round(outlier.side === "high" ? measured - upper : measured - lower, dp),
        source: `input.csv#row=${i}`,
      });
    }
    const ts = new Date(start + i * 41_000).toISOString();
    lines.push([
      `L3-${date.replaceAll("-", "")}-${String(i).padStart(4, "0")}`,
      ts, "L3", c.station, "3-BRK-210", `SN${String(100000 + Math.ceil(i / CHARS.length))}`,
      c.characteristic, c.nominal.toFixed(dp), lower.toFixed(dp), upper.toFixed(dp),
      measured.toFixed(dp), c.unit, INSPECTORS[i % INSPECTORS.length],
    ].join(","));
  }
  return { csv: `${lines.join("\n")}\n`, expected };
}

function write(dir, { csv, expected }, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "input.csv"), csv);
  fs.writeFileSync(
    path.join(dir, "expected.json"),
    `${JSON.stringify({ ...meta, exceptionCount: expected.length, exceptions: expected }, null, 2)}\n`,
  );
}

write(
  path.join(out, "line3-2026-10-14"),
  build({
    rows: 1240,
    seed: 20261014,
    date: "2026-10-14",
    outliers: [
      { row: 37, side: "high", by: 0.6 },
      { row: 214, side: "low", by: 1.2 },
      { row: 388, side: "high", by: 0.15 },
      { row: 501, side: "low", by: 0.4 },
      { row: 777, side: "high", by: 2.0 },
      { row: 1003, side: "low", by: 0.25 },
      { row: 1198, side: "high", by: 0.9 },
    ],
    boundaries: [12, 99, 640, 1111],
  }),
  { fixture: "line3-2026-10-14", line: "L3", date: "2026-10-14", rows: 1240, fictional: true },
);
write(
  path.join(out, "line3-clean"),
  build({ rows: 200, seed: 20261015, date: "2026-10-15", outliers: [], boundaries: [5, 150] }),
  { fixture: "line3-clean", line: "L3", date: "2026-10-15", rows: 200, fictional: true },
);
process.stdout.write(`fixtures written to ${out}\n`);
