// Line diff (Myers, O((N+M)·D)) with hard caps, for comparing draft versions.

export type DiffLine = {
  op: "eq" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

/** Edit script between two line arrays; null when more than `maxD` edits are needed. */
export function diffLines(a: string[], b: string[], maxD = 2000): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // Keep only the diagonals step d reads (k-1 … k+1 for |k| ≤ d): O(D²) memory in total.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    return null;
  }
  // Backtrack.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const at = (kk: number) => pv[kk + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ op: "eq", text: a[x], oldLine: x + 1, newLine: y + 1 });
    }
    if (x === prevX) {
      y--;
      out.push({ op: "add", text: b[y], oldLine: null, newLine: y + 1 });
    } else {
      x--;
      out.push({ op: "del", text: a[x], oldLine: x + 1, newLine: null });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push({ op: "eq", text: a[x], oldLine: x + 1, newLine: y + 1 });
  }
  return out.toReversed();
}

/** Group an edit script into hunks with `context` unchanged lines around each change. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const changed = lines.map((l, i) => (l.op === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) {
    return [];
  }
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(lines.length - 1, changed[0] + context);
  const flush = () => {
    const part = lines.slice(start, end + 1);
    const firstOld = part.find((l) => l.oldLine !== null)?.oldLine ?? 0;
    const firstNew = part.find((l) => l.newLine !== null)?.newLine ?? 0;
    hunks.push({
      oldStart: firstOld,
      oldLines: part.filter((l) => l.op !== "add").length,
      newStart: firstNew,
      newLines: part.filter((l) => l.op !== "del").length,
      lines: part,
    });
  };
  for (const i of changed.slice(1)) {
    if (i - context <= end + 1) {
      end = Math.min(lines.length - 1, i + context);
    } else {
      flush();
      start = Math.max(0, i - context);
      end = Math.min(lines.length - 1, i + context);
    }
  }
  flush();
  return hunks;
}
