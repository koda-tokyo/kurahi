import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { CpuProfile, HeapProfile } from "./inspector-profile.js";
import { cpuProfileToPprof, heapProfileToPprof } from "./pprof.js";

type Field = { field: number; wire: number; value: number | Uint8Array };

// Minimal protobuf reader: enough to check the pprof structure we write.
function readFields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = buf[i++];
      result += (b & 0x7f) * mul;
      mul *= 128;
      if (b < 0x80) {
        return result;
      }
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      out.push({ field, wire, value: varint() });
    } else if (wire === 2) {
      const len = varint();
      out.push({ field, wire, value: buf.slice(i, i + len) });
      i += len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return out;
}

function packed(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = bytes[i++];
      result += (b & 0x7f) * mul;
      mul *= 128;
      if (b < 0x80) {
        break;
      }
    }
    values.push(result);
  }
  return values;
}

const frame = (functionName: string, lineNumber = 0) => ({
  functionName,
  scriptId: "1",
  url: "file:///app.js",
  lineNumber,
  columnNumber: 0,
});

describe("pprof conversion", () => {
  test("cpu profile: leaf-first stacks, counts and nanoseconds, idle dropped", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2, 4] },
        { id: 2, callFrame: frame("main", 1), children: [3] },
        { id: 3, callFrame: frame("hot", 10) },
        { id: 4, callFrame: frame("(idle)") },
      ],
      startTime: 0,
      endTime: 4000,
      samples: [3, 3, 2, 4],
      timeDeltas: [0, 1000, 1000, 1000],
    };
    const decoded = gunzipSync(cpuProfileToPprof(profile, { capturedAtMs: 1 }));
    const fields = readFields(decoded);
    const strings = fields
      .filter((f) => f.field === 6)
      .map((f) => new TextDecoder().decode(f.value as Uint8Array));
    expect(strings[0]).toBe("");
    expect(strings).toEqual(expect.arrayContaining(["samples", "count", "cpu", "nanoseconds"]));
    expect(strings).toEqual(expect.arrayContaining(["main", "hot", "file:///app.js"]));
    expect(strings).not.toContain("(idle)");
    const samples = fields
      .filter((f) => f.field === 2)
      .map((f) => {
        const inner = readFields(f.value as Uint8Array);
        return {
          locations: packed(inner.find((x) => x.field === 1)!.value as Uint8Array),
          values: packed(inner.find((x) => x.field === 2)!.value as Uint8Array),
        };
      });
    expect(samples).toHaveLength(2);
    const hot = samples.find((s) => s.locations.length === 2)!;
    expect(hot.values[0]).toBe(2);
    expect(hot.values[1]).toBe(2_000_000);
    expect(fields.filter((f) => f.field === 4)).toHaveLength(2);
    expect(fields.filter((f) => f.field === 5)).toHaveLength(2);
  });

  test("heap profile: one sample per allocating node", () => {
    const profile: HeapProfile = {
      head: {
        callFrame: frame("(root)"),
        selfSize: 0,
        id: 1,
        children: [
          {
            callFrame: frame("alloc", 3),
            selfSize: 4096,
            id: 2,
            children: [{ callFrame: frame("inner", 7), selfSize: 1024, id: 3, children: [] }],
          },
        ],
      },
    };
    const fields = readFields(gunzipSync(heapProfileToPprof(profile)));
    const samples = fields
      .filter((f) => f.field === 2)
      .map((f) => readFields(f.value as Uint8Array));
    expect(samples).toHaveLength(2);
    const values = samples.map((s) => packed(s.find((x) => x.field === 2)!.value as Uint8Array)[0]);
    expect(values.toSorted((a, b) => a - b)).toEqual([1024, 4096]);
  });
});
