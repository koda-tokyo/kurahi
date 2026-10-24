import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditInput } from "../audit/audit-log.js";
import type { VoiceConfig } from "../config/types.voice.js";
import { FAKE_TTS_BYTES_PER_CHAR, fakeTranscript } from "./adapters/fake.js";
import { resolveVoiceConfig } from "./config.js";
import { VoiceManager, type VoiceManagerOptions } from "./manager.js";
import { VoiceError } from "./types.js";

type Sent = { connId: string; event: string; payload: Record<string, unknown> };

const pcm = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");

function setup(
  voice: VoiceConfig = {},
  extra: {
    tmpRoot?: string;
    stt?: VoiceManagerOptions["stt"];
    tts?: VoiceManagerOptions["tts"];
  } = {},
) {
  const events: Sent[] = [];
  const audits: AuditInput[] = [];
  const cfg: VoiceConfig = {
    enabled: true,
    stt: { adapter: "fake" },
    tts: { adapter: "fake" },
    ...voice,
  };
  const manager = new VoiceManager({
    config: () => resolveVoiceConfig(cfg),
    sink: () => (connId, event, payload) =>
      events.push({ connId, event, payload: payload as Record<string, unknown> }),
    audit: (a) => audits.push(a),
    tmpRoot: extra.tmpRoot,
    stt: extra.stt,
    tts: extra.tts,
  });
  return { manager, events, audits, cfg };
}

const A = { connId: "conn-a", actor: "owner" };
const B = { connId: "conn-b", actor: "owner" };

describe("VoiceManager push-to-talk", () => {
  it("streams partials, then one final, only to the owning connection", async () => {
    const { manager, events } = setup();
    const { sessionId } = manager.start(A, { lang: "ja" });
    for (let seq = 0; seq < 3; seq++) {
      await manager.audio(A, { sessionId, chunk: pcm(640), seq });
    }
    const final = await manager.stop(A, { sessionId });
    expect(final).toEqual({
      sessionId,
      text: fakeTranscript("ja", 3),
      lang: "ja",
      confidence: 0.99,
    });
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "voice.transcript.partial",
      "voice.transcript.partial",
      "voice.transcript.partial",
      "voice.transcript.final",
    ]);
    expect(events.every((e) => e.connId === "conn-a")).toBe(true);
    expect(events[0].payload).toEqual({ sessionId, text: fakeTranscript("ja", 1), lang: "ja" });
    expect(manager.activeSessions()).toBe(0);
  });

  it("returns the engine-detected language for auto, else the requested one", async () => {
    const { manager } = setup({ stt: { adapter: "fake", fake: { autoLang: "en" } } });
    const s1 = manager.start(A, { lang: "auto" });
    await manager.audio(A, { sessionId: s1.sessionId, chunk: pcm(320), seq: 0 });
    expect((await manager.stop(A, s1)).lang).toBe("en");
    const s2 = manager.start(A, { lang: "ja" });
    await manager.audio(A, { sessionId: s2.sessionId, chunk: pcm(320), seq: 0 });
    expect((await manager.stop(A, s2)).lang).toBe("ja");
  });

  it("cancel drops the session without a final and is audited without content", async () => {
    const { manager, events, audits } = setup();
    const { sessionId } = manager.start(A, { lang: "en" });
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    expect(await manager.cancel(A, { sessionId })).toEqual({ cancelled: [sessionId] });
    await expect(manager.stop(A, { sessionId })).rejects.toThrow(/unknown voice session/);
    expect(events.some((e) => e.event === "voice.transcript.final")).toBe(false);
    expect(audits.map((a) => a.action)).toEqual(["voice.start", "voice.cancel"]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(fakeTranscript("en", 1));
    expect(serialized).not.toContain(pcm(320));
  });

  it("another connection can neither feed, stop nor cancel a session", async () => {
    const { manager } = setup();
    const { sessionId } = manager.start(A, {});
    await expect(manager.audio(B, { sessionId, chunk: pcm(320), seq: 0 })).rejects.toThrow(
      VoiceError,
    );
    await expect(manager.stop(B, { sessionId })).rejects.toThrow(/unknown/);
    expect((await manager.cancel(B, {})).cancelled).toEqual([]);
    expect(manager.activeSessions()).toBe(1);
    await manager.closeConnection("conn-a");
    expect(manager.activeSessions()).toBe(0);
  });

  it("refuses everything while voice is disabled (the default)", () => {
    const { manager } = setup({ enabled: undefined });
    expect(() => manager.start(A, {})).toThrow(/not enabled/);
    expect(resolveVoiceConfig(undefined).enabled).toBe(false);
  });

  it("speaks: result first, then ordered audio.out chunks ending with done", async () => {
    const { manager, events, audits } = setup({ limits: { outChunkBytes: 1024 } });
    const text = "こんにちは";
    const res = await manager.speak(A, { text, lang: "ja" });
    expect(res.format).toMatch(/^audio\/L16/);
    expect(events).toHaveLength(0);
    await vi.waitFor(() => expect(events.at(-1)?.payload.done).toBe(true));
    const out = events.filter((e) => e.event === "voice.audio.out");
    expect(out.map((e) => e.payload.seq)).toEqual(out.map((_, i) => i));
    const total = out.reduce(
      (n, e) => n + Buffer.from(String(e.payload.chunk), "base64").length,
      0,
    );
    expect(total).toBe(Array.from(text).length * FAKE_TTS_BYTES_PER_CHAR);
    expect(out.every((e) => e.payload.speakId === res.speakId)).toBe(true);
    const speakAudit = audits.find((a) => a.action === "voice.speak");
    expect(speakAudit?.detail).toMatchObject({ chars: 5, lang: "ja" });
    expect(JSON.stringify(audits)).not.toContain(text);
  });

  it("cancel stops a speech mid-stream with a final done event", async () => {
    // An engine that sends one block, then waits until the request is aborted.
    const tts: VoiceManagerOptions["tts"] = () => ({
      id: "gated",
      locality: "local",
      async synthesize(req) {
        async function* audio() {
          yield new Uint8Array(2048);
          await new Promise((resolve) => req.signal.addEventListener("abort", resolve));
          yield new Uint8Array(2048);
        }
        return { format: "audio/wav", audio: audio() };
      },
    });
    const { manager, events } = setup({ limits: { outChunkBytes: 1024 } }, { tts });
    const res = await manager.speak(A, { text: "hello", lang: "en" });
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(await manager.cancel(A, {})).toEqual({ cancelled: [res.speakId] });
    await vi.waitFor(() => expect(events.at(-1)?.payload.done).toBe(true));
    expect(events.at(-1)?.payload).toMatchObject({ seq: 2, chunk: "", error: "cancelled" });
    expect(manager.activeSpeaks()).toBe(0);
  });

  it("a speech replaced while synthesizing fails as cancelled, not as an engine error", async () => {
    // The first synthesis honours the abort by rejecting; the second answers at once.
    let calls = 0;
    const tts: VoiceManagerOptions["tts"] = () => ({
      id: "abortable",
      locality: "local",
      async synthesize(req) {
        if (calls++ === 0) {
          await new Promise((_, reject) =>
            req.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        async function* audio() {
          yield new Uint8Array(16);
        }
        return { format: "audio/wav", audio: audio() };
      },
    });
    const { manager, events, audits } = setup({}, { tts });
    const first = manager.speak(A, { text: "one", lang: "en" });
    const second = await manager.speak(A, { text: "two", lang: "en" });
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(events.at(-1)?.payload.done).toBe(true));
    expect(events.every((e) => e.payload.speakId === second.speakId)).toBe(true);
    expect(audits.filter((a) => a.action === "voice.speak").map((a) => a.outcome)).toEqual(["ok"]);
    expect(audits.filter((a) => a.action === "voice.speak.cancel")).toHaveLength(1);
  });

  it("a speech cancelled before synthesis returns never answers with a speakId", async () => {
    // An engine that ignores the abort and resolves later anyway.
    let release!: () => void;
    let closed = false;
    const tts: VoiceManagerOptions["tts"] = () => ({
      id: "deaf",
      locality: "local",
      async synthesize() {
        await new Promise<void>((resolve) => (release = resolve));
        async function* audio() {
          try {
            yield new Uint8Array(16);
          } finally {
            closed = true;
          }
        }
        const it = audio();
        return {
          format: "audio/wav",
          audio: {
            [Symbol.asyncIterator]: () => ({
              next: () => it.next(),
              return: async () => {
                closed = true;
                return it.return(undefined);
              },
            }),
          },
        };
      },
    });
    const { manager, events } = setup({}, { tts });
    const pending = manager.speak(A, { text: "hello", lang: "en" });
    await vi.waitFor(() => expect(manager.activeSpeaks()).toBe(1));
    expect((await manager.cancel(A, {})).cancelled).toHaveLength(1);
    release();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(0);
    expect(closed).toBe(true);
    expect(manager.activeSpeaks()).toBe(0);
  });

  it("cancel ends the stream at once even when the engine ignores the abort", async () => {
    let closed = false;
    const tts: VoiceManagerOptions["tts"] = () => ({
      id: "stuck",
      locality: "local",
      async synthesize() {
        let n = 0;
        return {
          format: "audio/wav",
          audio: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                n++ === 0
                  ? Promise.resolve({ done: false, value: new Uint8Array(2048) })
                  : new Promise<IteratorResult<Uint8Array>>(() => {}),
              return: async () => {
                closed = true;
                return { done: true, value: undefined };
              },
            }),
          },
        };
      },
    });
    const { manager, events, audits } = setup({ limits: { outChunkBytes: 1024 } }, { tts });
    const res = await manager.speak(A, { text: "hello", lang: "en" });
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(await manager.cancel(A, {})).toEqual({ cancelled: [res.speakId] });
    await vi.waitFor(() => expect(events.at(-1)?.payload.done).toBe(true));
    expect(events.at(-1)?.payload).toMatchObject({ seq: 2, chunk: "", error: "cancelled" });
    expect(closed).toBe(true);
    expect(audits.find((a) => a.action === "voice.speak")?.outcome).toBe("cancelled");
  });
  it("a speech whose engine rejects the pending read on abort ends as cancelled, not failed", async () => {
    let closed = false;
    const tts: VoiceManagerOptions["tts"] = () => ({
      id: "honours-abort",
      locality: "local",
      async synthesize(req) {
        // Registered at synthesis, before the pump's own listener, so this rejection wins the race.
        let rejectNext: ((e: Error) => void) | undefined;
        req.signal?.addEventListener("abort", () => rejectNext?.(new Error("aborted")), {
          once: true,
        });
        let n = 0;
        return {
          format: "audio/wav",
          audio: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                n++ === 0
                  ? Promise.resolve({ done: false, value: new Uint8Array(2048) })
                  : new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
                      rejectNext = reject;
                    }),
              return: async () => {
                closed = true;
                return { done: true, value: undefined };
              },
            }),
          },
        };
      },
    });
    const { manager, events, audits } = setup({ limits: { outChunkBytes: 1024 } }, { tts });
    const res = await manager.speak(A, { text: "hello", lang: "en" });
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(await manager.cancel(A, {})).toEqual({ cancelled: [res.speakId] });
    await vi.waitFor(() => expect(events.at(-1)?.payload.done).toBe(true));
    expect(events.at(-1)?.payload).toMatchObject({ seq: 2, chunk: "", error: "cancelled" });
    expect(closed).toBe(true);
    expect(audits.find((a) => a.action === "voice.speak")?.outcome).toBe("cancelled");
  });
});

describe("VoiceManager limits", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("enforces chunk size, PCM16 alignment, base64 and sequence order", async () => {
    const { manager } = setup({ limits: { maxChunkBytes: 1000 } });
    const { sessionId } = manager.start(A, {});
    await expect(manager.audio(A, { sessionId, chunk: pcm(2000), seq: 0 })).rejects.toThrow(
      /exceeds 1000 bytes/,
    );
    await expect(manager.audio(A, { sessionId, chunk: pcm(3), seq: 0 })).rejects.toThrow(/PCM16/);
    await expect(manager.audio(A, { sessionId, chunk: "!!!!", seq: 0 })).rejects.toThrow(/base64/);
    await expect(manager.audio(A, { sessionId, chunk: pcm(320), seq: 1 })).rejects.toThrow(
      /out-of-order/,
    );
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    expect(await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 })).toMatchObject({
      duplicate: true,
    });
  });

  it("ends the session when the engine fails a write, so a retry is never a false duplicate", async () => {
    const written: number[] = [];
    let fail = false;
    const { manager, events, audits } = setup(
      {},
      {
        stt: () => ({
          id: "flaky",
          locality: "local",
          open: () => ({
            write: async (chunk: Buffer) => {
              if (fail) {
                throw new Error("stream reset");
              }
              written.push(chunk.length);
            },
            finish: async () => ({ text: "never" }),
            abort: () => undefined,
          }),
        }),
      },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    fail = true;
    await expect(manager.audio(A, { sessionId, chunk: pcm(640), seq: 1 })).rejects.toMatchObject({
      code: "engine",
    });
    // The lost chunk must not be acknowledged on retry: the session is gone.
    await expect(manager.audio(A, { sessionId, chunk: pcm(640), seq: 1 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(written).toEqual([320]);
    expect(manager.activeSessions()).toBe(0);
    expect(events.at(-1)).toEqual({
      connId: "conn-a",
      event: "voice.session.ended",
      payload: { sessionId, reason: "error" },
    });
    expect(audits.at(-1)).toMatchObject({
      action: "voice.cancel",
      detail: { sessionId, reason: "error", chunks: 1, bytes: 320 },
    });
  });

  it("a stop during a pending write waits for it; a failed write gives no final and no success", async () => {
    const writes: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    let finished = 0;
    const { manager, events, audits } = setup(
      {},
      {
        stt: () => ({
          id: "slow",
          locality: "local",
          open: () => ({
            write: () =>
              new Promise<void>((resolve, reject) => {
                writes.push({ resolve, reject });
              }),
            finish: async () => {
              finished += 1;
              return { text: "never" };
            },
            abort: () => undefined,
          }),
        }),
      },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    const first = manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    const retry = manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    const stop = manager.stop(A, { sessionId });
    const firstErr = first.catch((e: unknown) => e);
    const retryErr = retry.catch((e: unknown) => e);
    const stopErr = stop.catch((e: unknown) => e);
    await new Promise((r) => setImmediate(r));
    expect(writes).toHaveLength(1);
    expect(finished).toBe(0);
    writes[0].reject(new Error("stream reset"));
    expect(await firstErr).toMatchObject({ code: "engine" });
    expect(await retryErr).toMatchObject({ code: "engine" });
    expect(await stopErr).toMatchObject({ code: "engine" });
    expect(finished).toBe(0);
    expect(manager.activeSessions()).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["voice.session.ended"]);
    expect(events[0].payload).toEqual({ sessionId, reason: "error" });
    expect(audits.filter((a) => a.outcome === "ok").map((a) => a.action)).toEqual(["voice.start"]);
    expect(audits.at(-1)).toMatchObject({
      action: "voice.stop",
      outcome: "error",
      detail: { sessionId, chunks: 0, bytes: 0 },
    });
  });

  it("writes chunks one at a time and acks a pending retry only once the engine took it", async () => {
    const writes: Array<{ len: number; resolve: () => void }> = [];
    const { manager, audits } = setup(
      {},
      {
        stt: () => ({
          id: "slow",
          locality: "local",
          open: () => ({
            write: (chunk: Buffer) =>
              new Promise<void>((resolve) => {
                writes.push({ len: chunk.length, resolve });
              }),
            finish: async () => ({ text: "ok" }),
            abort: () => undefined,
          }),
        }),
      },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    const a0 = manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    const a1 = manager.audio(A, { sessionId, chunk: pcm(640), seq: 1 });
    let retried = false;
    const r0 = manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 }).then((v) => {
      retried = true;
      return v;
    });
    await new Promise((r) => setImmediate(r));
    expect(writes.map((w) => w.len)).toEqual([320]);
    expect(retried).toBe(false);
    writes[0].resolve();
    expect(await r0).toEqual({ sessionId, seq: 0, duplicate: true });
    await a0;
    await new Promise((r) => setImmediate(r));
    expect(writes.map((w) => w.len)).toEqual([320, 640]);
    const stop = manager.stop(A, { sessionId });
    writes[1].resolve();
    await a1;
    expect((await stop).text).toBe("ok");
    expect(audits.at(-1)).toMatchObject({
      action: "voice.stop",
      outcome: "ok",
      detail: { chunks: 2, bytes: 960, audioMs: 30 },
    });
  });

  it("enforces the chunk rate", async () => {
    const { manager } = setup({ limits: { maxChunksPerSecond: 3 } });
    const { sessionId } = manager.start(A, {});
    for (let seq = 0; seq < 3; seq++) {
      await manager.audio(A, { sessionId, chunk: pcm(320), seq });
    }
    await expect(manager.audio(A, { sessionId, chunk: pcm(320), seq: 3 })).rejects.toThrow(
      /rate exceeded/,
    );
    vi.advanceTimersByTime(1001);
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 3 });
  });

  it("enforces the real-time factor (1 s burst, then wall clock)", async () => {
    const { manager } = setup({ limits: { realtimeFactor: 1 } });
    const { sessionId } = manager.start(A, {});
    await manager.audio(A, { sessionId, chunk: pcm(32_000), seq: 0 }); // 1 s of audio: the burst
    await expect(manager.audio(A, { sessionId, chunk: pcm(320), seq: 1 })).rejects.toThrow(
      /faster than real time/,
    );
    vi.advanceTimersByTime(500);
    await manager.audio(A, { sessionId, chunk: pcm(16_000), seq: 1 });
  });

  it("caps the session length: the timer finalizes and reports reason limit", async () => {
    const { manager, events } = setup({ limits: { maxSessionMs: 2000 } });
    const { sessionId } = manager.start(A, { lang: "en" });
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    await vi.advanceTimersByTimeAsync(2001);
    expect(events.map((e) => e.event)).toEqual([
      "voice.transcript.partial",
      "voice.transcript.final",
      "voice.session.ended",
    ]);
    expect(events.at(-1)?.payload).toEqual({ sessionId, reason: "limit" });
    expect(manager.activeSessions()).toBe(0);
  });

  const hungStt =
    (aborted: { n: number }): VoiceManagerOptions["stt"] =>
    () => ({
      id: "hung",
      locality: "local",
      open: () => ({
        write: () => new Promise<void>(() => {}),
        finish: async () => ({ text: "never" }),
        abort: () => {
          aborted.n += 1;
        },
      }),
    });

  it("a stop fails after the idle timeout when a write never settles", async () => {
    const aborted = { n: 0 };
    const { manager, events, audits } = setup(
      { limits: { idleTimeoutMs: 1000 } },
      { stt: hungStt(aborted) },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    void manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 }).catch(() => {});
    const stopErr = manager.stop(A, { sessionId }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.activeSessions()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await stopErr).toMatchObject({ code: "engine" });
    expect(aborted.n).toBe(1);
    expect(manager.activeSessions()).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["voice.session.ended"]);
    expect(events[0].payload).toEqual({ sessionId, reason: "error" });
    expect(audits.at(-1)).toMatchObject({ action: "voice.stop", outcome: "error" });
  });

  it("a cancel releases a stop that waits on a write that never settles", async () => {
    const aborted = { n: 0 };
    const { manager, events, audits } = setup({}, { stt: hungStt(aborted) });
    const { sessionId } = manager.start(A, { lang: "en" });
    void manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 }).catch(() => {});
    const stopErr = manager.stop(A, { sessionId }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await manager.cancel(A, { sessionId })).toEqual({ cancelled: [sessionId] });
    expect(await stopErr).toMatchObject({ code: "engine", message: "voice session was cancelled" });
    expect(events).toEqual([]);
    expect(audits.some((a) => a.action === "voice.stop")).toBe(false);
  });

  it("a write that settles after a stop timed out is never accepted, and the queue stops", async () => {
    const calls = { n: 0 };
    let release!: () => void;
    const { manager, events, audits } = setup(
      { limits: { idleTimeoutMs: 1000 } },
      {
        stt: () => ({
          id: "late",
          locality: "local",
          open: () => ({
            write: () => {
              calls.n += 1;
              return new Promise<void>((r) => (release = r));
            },
            finish: async () => ({ text: "late" }),
            abort: () => {},
          }),
        }),
      },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    const a0 = manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 }).catch((e: unknown) => e);
    const a1 = manager.audio(A, { sessionId, chunk: pcm(320), seq: 1 }).catch((e: unknown) => e);
    const stopErr = manager.stop(A, { sessionId }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await stopErr).toMatchObject({ code: "engine", message: "speech engine failed" });
    expect(calls.n).toBe(1);
    release();
    expect(await a0).toMatchObject({ code: "engine" });
    expect(await a1).toMatchObject({ code: "engine" });
    expect(calls.n).toBe(1);
    expect(manager.activeSessions()).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["voice.session.ended"]);
    expect(audits.filter((a) => a.action === "voice.stop")).toHaveLength(1);
    expect(audits.at(-1)).toMatchObject({ action: "voice.stop", outcome: "error" });
    expect(audits.at(-1)?.detail).toMatchObject({ chunks: 0, bytes: 0 });
  });

  const hungFinish = (late: { resolve?: (r: { text: string }) => void }) =>
    (() => ({
      id: "hung-finish",
      locality: "local",
      open: () => ({
        write: async () => {},
        finish: () => new Promise<{ text: string }>((r) => (late.resolve = r)),
        abort: () => {},
      }),
    })) as VoiceManagerOptions["stt"];

  it("a stop fails after the idle timeout when finish never settles; a late result is dropped", async () => {
    const late: { resolve?: (r: { text: string }) => void } = {};
    const { manager, events, audits } = setup(
      { limits: { idleTimeoutMs: 1000 } },
      { stt: hungFinish(late) },
    );
    const { sessionId } = manager.start(A, { lang: "en" });
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    const stopErr = manager.stop(A, { sessionId }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.activeSessions()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await stopErr).toMatchObject({ code: "engine", message: "speech engine failed" });
    late.resolve?.({ text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.activeSessions()).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["voice.session.ended"]);
    expect(audits.filter((a) => a.action === "voice.stop")).toHaveLength(1);
    expect(audits.at(-1)).toMatchObject({ action: "voice.stop", outcome: "error" });
  });

  it("a cancel releases a stop that waits on a finish that never settles", async () => {
    const late: { resolve?: (r: { text: string }) => void } = {};
    const { manager, events, audits } = setup({}, { stt: hungFinish(late) });
    const { sessionId } = manager.start(A, { lang: "en" });
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    const stopErr = manager.stop(A, { sessionId }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.resolve).toBeDefined();
    expect(await manager.cancel(A, { sessionId })).toEqual({ cancelled: [sessionId] });
    expect(await stopErr).toMatchObject({ code: "engine", message: "voice session was cancelled" });
    late.resolve?.({ text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(audits.some((a) => a.action === "voice.stop")).toBe(false);
  });

  it("cancels an idle session and limits concurrent sessions per connection", async () => {
    const { manager, events } = setup({ limits: { idleTimeoutMs: 1000 } });
    const { sessionId } = manager.start(A, {});
    expect(() => manager.start(A, {})).toThrow(/already active/);
    expect(manager.start(B, {}).sessionId).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1001);
    expect(events.find((e) => e.connId === "conn-a")?.payload).toEqual({
      sessionId,
      reason: "idle",
    });
  });

  it("rejects speak text over the limit and bad rates", async () => {
    const { manager } = setup({ limits: { maxSpeakChars: 4 } });
    await expect(manager.speak(A, { text: "hello", lang: "en" })).rejects.toThrow(/exceeds 4/);
    await expect(manager.speak(A, { text: "hi", lang: "en", rate: 3 })).rejects.toThrow(/rate/);
    await expect(manager.speak(A, { text: "hi", lang: "en", voice: "../x y" })).rejects.toThrow(
      /voice id/,
    );
  });
});

describe("VoiceManager privacy with a local engine", () => {
  let root: string;
  let engine: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
    engine = path.join(root, "engine.cjs");
    // A stand-in whisper.cpp CLI: reports the input file mode and size, detects "ja".
    fs.writeFileSync(
      engine,
      `const fs = require("node:fs");
const [input, lang] = process.argv.slice(2);
const st = fs.statSync(input);
process.stdout.write(JSON.stringify({
  text: "mode=" + (st.mode & 0o777).toString(8) + " size=" + st.size + " lang=" + lang,
  language: "japanese",
}));`,
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const tmpRoot = () => {
    const dir = path.join(root, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // POSIX file modes; Windows has no 0600 mode (privacy there comes from the per-user temp folder ACL).
  it.skipIf(process.platform === "win32")(
    "writes a 0600 WAV only for the run and leaves nothing on disk after stop",
    async () => {
      const dir = tmpRoot();
      const { manager, audits } = setup(
        {
          stt: {
            adapter: "local-cli",
            localCli: { binary: process.execPath, args: [engine, "{input}", "{lang}"] },
          },
        },
        { tmpRoot: dir },
      );
      const { sessionId } = manager.start(A, { lang: "auto" });
      await manager.audio(A, { sessionId, chunk: pcm(3200), seq: 0 });
      await manager.audio(A, { sessionId, chunk: pcm(3200), seq: 1 });
      expect(fs.readdirSync(dir)).toEqual([]); // audio stays in memory until stop
      const final = await manager.stop(A, { sessionId });
      expect(final.text).toBe(`mode=600 size=${44 + 6400} lang=auto`);
      expect(final.lang).toBe("ja");
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(audits.find((a) => a.action === "voice.stop")?.outcome).toBe("ok");
    },
  );

  it("removes temp audio after an engine failure as well", async () => {
    const dir = tmpRoot();
    const failing = path.join(root, "fail.cjs");
    fs.writeFileSync(failing, "process.exit(3);");
    const { manager, events } = setup(
      {
        stt: {
          adapter: "local-cli",
          localCli: { binary: process.execPath, args: [failing, "{input}"] },
        },
      },
      { tmpRoot: dir },
    );
    const { sessionId } = manager.start(A, {});
    await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
    await expect(manager.stop(A, { sessionId })).rejects.toThrow(/exited with code 3/);
    expect(events.at(-1)?.payload).toEqual({ sessionId, reason: "error" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // POSIX file modes; Windows has no 0600 mode (privacy there comes from the per-user temp folder ACL).
  it.skipIf(process.platform === "win32")(
    "keeps audio only with the explicit admin opt-in, as 0600 files",
    async () => {
      const dir = tmpRoot();
      const keep = path.join(root, "kept");
      const { manager } = setup(
        {
          stt: {
            adapter: "local-cli",
            localCli: { binary: process.execPath, args: [engine, "{input}", "{lang}"] },
          },
          privacy: { keepAudio: true, keepAudioDir: keep },
        },
        { tmpRoot: dir },
      );
      const { sessionId } = manager.start(A, { lang: "en" });
      await manager.audio(A, { sessionId, chunk: pcm(320), seq: 0 });
      await manager.stop(A, { sessionId });
      expect(fs.readdirSync(dir)).toEqual([]);
      const kept = fs.readdirSync(keep);
      expect(kept).toEqual([`${sessionId}-audio-1.wav`]);
      expect(fs.statSync(path.join(keep, kept[0])).mode & 0o777).toBe(0o600);
      // keepAudio without a directory is not honoured.
      expect(resolveVoiceConfig({ privacy: { keepAudio: true } }).keepAudio).toBe(false);
    },
  );
});
