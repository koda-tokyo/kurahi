// V8 profiles -> pprof (github.com/google/pprof, proto/profile.proto), gzip-compressed, without
// a protobuf dependency: the format needs only varints and length-delimited fields.
//
// CPU: one location per profile node (leaf first in each sample), values `samples/count` and
// `cpu/nanoseconds`; `(idle)` samples are dropped, since they are not CPU time.
// Heap: the sampling heap profile's self sizes, value `space/bytes` per allocation stack.

import { gzipSync } from "node:zlib";
import type { CpuProfile, HeapProfile, HeapProfileNode } from "./inspector-profile.js";

class ProtoWriter {
  private chunks: number[] = [];

  varint(value: number): void {
    let v = Math.max(0, Math.floor(value));
    while (v >= 0x80) {
      this.chunks.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.chunks.push(v);
  }

  tag(field: number, wireType: 0 | 2): void {
    this.varint(field * 8 + wireType);
  }

  uint(field: number, value: number): void {
    if (value === 0) {
      return;
    }
    this.tag(field, 0);
    this.varint(value);
  }

  bytes(field: number, data: Uint8Array): void {
    this.tag(field, 2);
    this.varint(data.length);
    for (const b of data) {
      this.chunks.push(b);
    }
  }

  message(field: number, build: (w: ProtoWriter) => void): void {
    const inner = new ProtoWriter();
    build(inner);
    this.bytes(field, inner.finish());
  }

  packed(field: number, values: number[]): void {
    if (values.length === 0) {
      return;
    }
    const inner = new ProtoWriter();
    for (const v of values) {
      inner.varint(v);
    }
    this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

type CallFrame = CpuProfile["nodes"][number]["callFrame"];

class ProfileBuilder {
  private strings = new Map<string, number>([["", 0]]);
  private functions = new Map<string, { id: number; name: number; file: number; line: number }>();
  private locations: Array<{ id: number; functionId: number; line: number }> = [];
  readonly samples: Array<{ locations: number[]; values: number[] }> = [];

  str(value: string): number {
    let idx = this.strings.get(value);
    if (idx === undefined) {
      idx = this.strings.size;
      this.strings.set(value, idx);
    }
    return idx;
  }

  location(frame: CallFrame): number {
    const name = frame.functionName || "(anonymous)";
    const file = frame.url || "";
    const line = frame.lineNumber + 1;
    const fnKey = `${name}\u0000${file}\u0000${line}`;
    let fn = this.functions.get(fnKey);
    if (!fn) {
      fn = { id: this.functions.size + 1, name: this.str(name), file: this.str(file), line };
      this.functions.set(fnKey, fn);
    }
    const id = this.locations.length + 1;
    this.locations.push({ id, functionId: fn.id, line });
    return id;
  }

  encode(params: {
    sampleTypes: Array<[string, string]>;
    periodType: [string, string];
    period: number;
    timeNanos: number;
    durationNanos: number;
  }): Buffer {
    const sampleTypes = params.sampleTypes.map(([t, u]) => [this.str(t), this.str(u)] as const);
    const periodType = [this.str(params.periodType[0]), this.str(params.periodType[1])] as const;
    const w = new ProtoWriter();
    for (const [t, u] of sampleTypes) {
      w.message(1, (m) => {
        m.uint(1, t);
        m.uint(2, u);
      });
    }
    for (const s of this.samples) {
      w.message(2, (m) => {
        m.packed(1, s.locations);
        m.packed(2, s.values);
      });
    }
    for (const loc of this.locations) {
      w.message(4, (m) => {
        m.uint(1, loc.id);
        m.message(4, (line) => {
          line.uint(1, loc.functionId);
          line.uint(2, loc.line);
        });
      });
    }
    for (const fn of this.functions.values()) {
      w.message(5, (m) => {
        m.uint(1, fn.id);
        m.uint(2, fn.name);
        m.uint(3, fn.name);
        m.uint(4, fn.file);
        m.uint(5, fn.line);
      });
    }
    const encoder = new TextEncoder();
    for (const s of this.strings.keys()) {
      w.bytes(6, encoder.encode(s));
    }
    w.uint(9, params.timeNanos);
    w.uint(10, params.durationNanos);
    w.message(11, (m) => {
      m.uint(1, periodType[0]);
      m.uint(2, periodType[1]);
    });
    w.uint(12, params.period);
    return gzipSync(w.finish());
  }
}

/** Converts a `.cpuprofile` to a gzipped pprof profile. `capturedAtMs` is the wall-clock start. */
export function cpuProfileToPprof(
  profile: CpuProfile,
  opts: { capturedAtMs?: number; samplingIntervalUs?: number } = {},
): Buffer {
  const builder = new ProfileBuilder();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) {
      parent.set(c, n.id);
    }
  }
  const locationOf = new Map<number, number>();
  const stackOf = (nodeId: number): number[] => {
    const stack: number[] = [];
    let cur: number | undefined = nodeId;
    while (cur !== undefined) {
      const node = byId.get(cur);
      if (!node || node.callFrame.functionName === "(root)") {
        break;
      }
      let loc = locationOf.get(cur);
      if (loc === undefined) {
        loc = builder.location(node.callFrame);
        locationOf.set(cur, loc);
      }
      stack.push(loc);
      cur = parent.get(cur);
    }
    return stack;
  };
  const totals = new Map<number, { count: number; us: number }>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const interval = opts.samplingIntervalUs ?? 1000;
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i];
    const t = totals.get(id) ?? { count: 0, us: 0 };
    t.count += 1;
    // The delta before the next sample is the time this sample stood for.
    t.us += Math.max(0, deltas[i + 1] ?? interval);
    totals.set(id, t);
  }
  if (samples.length === 0) {
    for (const n of profile.nodes) {
      if (n.hitCount) {
        totals.set(n.id, { count: n.hitCount, us: n.hitCount * interval });
      }
    }
  }
  for (const [id, t] of totals) {
    if (byId.get(id)?.callFrame.functionName === "(idle)") {
      continue;
    }
    const stack = stackOf(id);
    if (stack.length > 0) {
      builder.samples.push({ locations: stack, values: [t.count, Math.round(t.us * 1000)] });
    }
  }
  return builder.encode({
    sampleTypes: [
      ["samples", "count"],
      ["cpu", "nanoseconds"],
    ],
    periodType: ["cpu", "nanoseconds"],
    period: interval * 1000,
    timeNanos: (opts.capturedAtMs ?? Date.now()) * 1e6,
    durationNanos: Math.max(0, profile.endTime - profile.startTime) * 1000,
  });
}

/** Converts a sampling `.heapprofile` to a gzipped pprof profile. */
export function heapProfileToPprof(
  profile: HeapProfile,
  opts: { capturedAtMs?: number; samplingIntervalBytes?: number } = {},
): Buffer {
  const builder = new ProfileBuilder();
  const walk = (node: HeapProfileNode, stack: number[]) => {
    const here =
      node.callFrame.functionName === "(root)"
        ? stack
        : [builder.location(node.callFrame), ...stack];
    if (node.selfSize > 0 && here.length > 0) {
      builder.samples.push({ locations: here, values: [node.selfSize] });
    }
    for (const child of node.children ?? []) {
      walk(child, here);
    }
  };
  walk(profile.head, []);
  return builder.encode({
    sampleTypes: [["space", "bytes"]],
    periodType: ["space", "bytes"],
    period: opts.samplingIntervalBytes ?? 32 * 1024,
    timeNanos: (opts.capturedAtMs ?? Date.now()) * 1e6,
    durationNanos: 0,
  });
}
