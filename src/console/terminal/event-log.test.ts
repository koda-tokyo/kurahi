import { describe, expect, it } from "vitest";
import { EventRing, RING_MAX_BYTES, RING_MAX_EVENTS } from "./event-log.js";

describe("EventRing", () => {
  it("assigns monotonic seq per session and replays after a seq", () => {
    const ring = new EventRing("s1", undefined, () => 42);
    for (let i = 0; i < 5; i++) {
      ring.append({ type: "stdout", data: `line ${i}\r\n` });
    }
    const r = ring.replay(2);
    expect(r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(r.events[0]).toMatchObject({ sessionId: "s1", ts: 42, type: "stdout" });
    expect(r).toMatchObject({ truncated: false, hasMore: false, lastSeq: 5 });
    expect(ring.replay(5).events).toEqual([]);
  });

  it("pages replay at 200 events", () => {
    const ring = new EventRing("s1");
    for (let i = 0; i < 450; i++) {
      ring.append({ type: "stdout", data: "x" });
    }
    const first = ring.replay(0);
    expect(first.events).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const second = ring.replay(first.events[199].seq);
    expect(second.events[0].seq).toBe(201);
    const last = ring.replay(400);
    expect(last.events).toHaveLength(50);
    expect(last.hasMore).toBe(false);
  });

  it("drops the oldest events beyond 5,000 and reports truncation", () => {
    expect(RING_MAX_EVENTS).toBe(5_000);
    const ring = new EventRing("s1");
    for (let i = 0; i < 5_100; i++) {
      ring.append({ type: "stdout", data: "x" });
    }
    expect(ring.size).toBe(5_000);
    const r = ring.replay(0);
    expect(r.truncated).toBe(true);
    expect(r.events[0].seq).toBe(101);
    expect(ring.replay(100).truncated).toBe(false);
    expect(ring.replay(5_099).events.map((e) => e.seq)).toEqual([5_100]);
  });

  it("drops the oldest events beyond 10 MB", () => {
    expect(RING_MAX_BYTES).toBe(10 * 1024 * 1024);
    const ring = new EventRing("s1");
    const chunk = "y".repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) {
      ring.append({ type: "stdout", data: chunk });
    }
    expect(ring.byteSize).toBeLessThanOrEqual(RING_MAX_BYTES);
    expect(ring.size).toBeLessThan(12);
    expect(ring.replay(0).truncated).toBe(true);
    expect(ring.lastSeq).toBe(12);
  });

  it("rewrites a kept event in place without changing seq", () => {
    const ring = new EventRing("s1");
    ring.append({ type: "stdout", data: "secret" });
    ring.append({ type: "stdout", data: "\r\n" });
    expect(ring.rewrite(1, (e) => ({ ...e, data: "" }) as typeof e)).toBe(true);
    expect(ring.replay(0).events.map((e) => ("data" in e ? e.data : null))).toEqual(["", "\r\n"]);
    expect(ring.rewrite(9, (e) => e)).toBe(false);
  });
});
