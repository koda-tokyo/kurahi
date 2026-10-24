// Output path of a running console terminal command: rate limit, then redaction, then
// coalescing into `stdout` events (at most one event per 30 ms or per 32 KiB), so a noisy
// command does not flood the ring buffer with tiny events.

import type { StreamRedactor } from "./redact.js";

const FLUSH_MS = 30;
const FLUSH_BYTES = 32 * 1024;
const WINDOW_MS = 1000;

export class OutputPipe {
  totalBytes = 0;
  droppedBytes = 0;
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowStart: number;
  private windowBytes = 0;
  private windowDropped = 0;

  constructor(
    private readonly opts: {
      bytesPerSecond: number;
      redactor: StreamRedactor;
      emit: (data: string) => void;
      /** Called with the bytes dropped in a one-second window, after the window. */
      onDropped: (bytes: number) => void;
      now?: () => number;
    },
  ) {
    this.windowStart = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private rollWindow(): void {
    const now = this.now();
    if (now - this.windowStart < WINDOW_MS) {
      return;
    }
    if (this.windowDropped > 0) {
      this.opts.onDropped(this.windowDropped);
    }
    this.windowStart = now;
    this.windowBytes = 0;
    this.windowDropped = 0;
  }

  write(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += bytes;
    this.rollWindow();
    if (this.windowBytes + bytes > this.opts.bytesPerSecond) {
      this.windowDropped += bytes;
      this.droppedBytes += bytes;
      return;
    }
    this.windowBytes += bytes;
    this.pending += this.opts.redactor.push(chunk);
    if (this.pending.length >= FLUSH_BYTES) {
      this.emitPending();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pending += this.opts.redactor.flush();
        this.emitPending();
      }, FLUSH_MS);
      this.timer.unref?.();
    }
  }

  private emitPending(): void {
    if (this.pending) {
      const data = this.pending;
      this.pending = "";
      this.opts.emit(data);
    }
  }

  /** Emit everything held (the command exited or was killed). */
  finish(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending += this.opts.redactor.flush();
    this.emitPending();
    if (this.windowDropped > 0) {
      this.opts.onDropped(this.windowDropped);
      this.windowDropped = 0;
    }
  }
}
