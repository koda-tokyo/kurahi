// Per-session event ring for the console terminal. Every event gets the next `seq` (strictly
// increasing from 1). The ring keeps the newest 5,000 events and at most 10 MB; older events are
// dropped and a replay that starts before the oldest kept event reports `truncated: true`.

import type { TerminalEvent } from "../../gateway/protocol/index.js";

export const RING_MAX_EVENTS = 5_000;
export const RING_MAX_BYTES = 10 * 1024 * 1024;
export const REPLAY_PAGE = 200;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TerminalEventInput = DistributiveOmit<TerminalEvent, "seq" | "sessionId" | "ts">;

type Slot = { event: TerminalEvent; bytes: number };

const sizeOf = (event: TerminalEvent) => Buffer.byteLength(JSON.stringify(event), "utf8");

export class EventRing {
  private slots: Slot[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly limits = { maxEvents: RING_MAX_EVENTS, maxBytes: RING_MAX_BYTES },
    private readonly now: () => number = Date.now,
  ) {}

  /** Seq of the newest event (0 before the first). */
  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.slots.length - this.head;
  }

  get byteSize(): number {
    return this.bytes;
  }

  append(input: TerminalEventInput): TerminalEvent {
    this.seq += 1;
    const event = {
      ...input,
      sessionId: this.sessionId,
      seq: this.seq,
      ts: this.now(),
    } as TerminalEvent;
    const bytes = sizeOf(event);
    this.slots.push({ event, bytes });
    this.bytes += bytes;
    while (
      this.size > 1 &&
      (this.size > this.limits.maxEvents || this.bytes > this.limits.maxBytes)
    ) {
      this.bytes -= this.slots[this.head].bytes;
      this.head += 1;
    }
    if (this.head > 1024 && this.head * 2 > this.slots.length) {
      this.slots = this.slots.slice(this.head);
      this.head = 0;
    }
    return event;
  }

  /** Replace a kept event's payload in place (seq and type stay). False when it was dropped. */
  rewrite(seq: number, patch: (event: TerminalEvent) => TerminalEvent): boolean {
    const first = this.slots[this.head]?.event.seq ?? this.seq + 1;
    const idx = this.head + (seq - first);
    const slot = this.slots[idx];
    if (!slot || slot.event.seq !== seq) {
      return false;
    }
    const next = { ...patch(slot.event), seq: slot.event.seq, sessionId: this.sessionId };
    const bytes = sizeOf(next as TerminalEvent);
    this.bytes += bytes - slot.bytes;
    this.slots[idx] = { event: next as TerminalEvent, bytes };
    return true;
  }

  replay(
    afterSeq: number,
    limit = REPLAY_PAGE,
  ): { events: TerminalEvent[]; truncated: boolean; hasMore: boolean; lastSeq: number } {
    const page = Math.max(1, Math.min(REPLAY_PAGE, Math.floor(limit)));
    const firstKept = this.slots[this.head]?.event.seq;
    const truncated = firstKept !== undefined && afterSeq + 1 < firstKept;
    const events: TerminalEvent[] = [];
    if (firstKept !== undefined) {
      const start = this.head + Math.max(0, afterSeq + 1 - firstKept);
      for (let i = start; i < this.slots.length && events.length < page; i++) {
        events.push(this.slots[i].event);
      }
    }
    const last = events[events.length - 1]?.seq ?? afterSeq;
    return { events, truncated, hasMore: last < this.seq, lastSeq: this.seq };
  }
}
