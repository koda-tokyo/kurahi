// Push-to-talk session manager: owns the per-connection voice sessions behind the gateway
// `voice.*` methods, enforces the limits, streams events back to the one connection that owns
// the session, and audits start / stop / cancel / speak without any content.
//
// Privacy: audio is held in memory, handed to the adapter, and zeroed; any temp file an adapter
// needs lives in the session's private dir, removed when the session ends (ephemeral.ts).
// Transcripts are never stored here: the UI edits the final text and sends it as a normal chat
// message, which is the only place a transcript is persisted.
import { randomUUID } from "node:crypto";
import type { AuditInput } from "../audit/audit-log.js";
import type { ResolvedVoiceConfig } from "./config.js";
import type {
  SpeechToText,
  SttStream,
  TextToSpeech,
  VoiceLang,
  VoiceLangRequest,
} from "./types.js";
import { DEFAULT_VOICE_LANG } from "./config.js";
import { EphemeralAudioDir } from "./ephemeral.js";
import { createSpeechToText, createTextToSpeech } from "./registry.js";
import { VOICE_BYTES_PER_MS, VoiceError } from "./types.js";

export type VoiceEventSink = (connId: string, event: string, payload: unknown) => void;

export type VoiceCaller = { connId: string; actor: string };

export type VoiceEndReason = "limit" | "idle" | "error" | "disconnected" | "shutdown";

export type VoiceTranscriptFinal = {
  sessionId: string;
  text: string;
  lang: VoiceLang;
  confidence?: number;
};

export type VoiceManagerOptions = {
  config: () => ResolvedVoiceConfig;
  sink: () => VoiceEventSink | null;
  audit: (input: AuditInput) => void;
  /** Parent for private temp dirs (tests). */
  tmpRoot?: string;
  /** Adapter overrides (tests); default: the registry, per config. */
  stt?: (cfg: ResolvedVoiceConfig) => SpeechToText;
  tts?: (cfg: ResolvedVoiceConfig) => TextToSpeech;
};

type Session = {
  id: string;
  connId: string;
  actor: string;
  projectId?: string;
  lang: VoiceLangRequest;
  adapterId: string;
  stream: SttStream;
  abort: AbortController;
  ephemeral: EphemeralAudioDir;
  startedAt: number;
  nextSeq: number;
  /** Bytes admitted for the rate/length limits (queued or accepted). */
  queuedBytes: number;
  /** Bytes / chunks the engine accepted (audit and audioMs). */
  bytes: number;
  chunks: number;
  /** Writes run one at a time in seq order; resolves false once any write failed. */
  writes: Promise<boolean>;
  /** Writes still pending, by seq, so a retry gets the original write's outcome. */
  inflight: Map<number, Promise<void>>;
  recent: number[];
  state: "open" | "finishing";
  /** Set once the session ended (stopped, failed, cancelled): queued or late writes never count. */
  closed: boolean;
  /** How long a stop waits on the engine (pending writes, then finish) before failing the session. */
  drainMs: number;
  maxTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
};

type Speak = { id: string; connId: string; abort: AbortController };

/** Ask the engine stream to release its resources; it may be mid-read, so never wait on it. */
function closeAudio(it: AsyncIterator<Uint8Array>) {
  try {
    void it.return?.()?.catch(() => {});
  } catch {
    /* already closed */
  }
}

const GLOBAL_MAX_SESSIONS = 64;
const VOICE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export class VoiceManager {
  private readonly sessions = new Map<string, Session>();
  private readonly speaks = new Map<string, Speak>();

  constructor(private readonly opts: VoiceManagerOptions) {}

  activeSessions(): number {
    return this.sessions.size;
  }

  activeSpeaks(): number {
    return this.speaks.size;
  }

  private enabledConfig(): ResolvedVoiceConfig {
    const cfg = this.opts.config();
    if (!cfg.enabled) {
      throw new VoiceError("disabled", "voice is not enabled on this gateway");
    }
    return cfg;
  }

  private emit(connId: string, event: string, payload: unknown) {
    try {
      this.opts.sink()?.(connId, event, payload);
    } catch {
      /* a dead socket must not break the session bookkeeping */
    }
  }

  private audit(caller: { actor: string }, action: string, outcome: string, detail: object) {
    try {
      this.opts.audit({ identity: caller.actor, action, outcome, source: "gateway.voice", detail });
    } catch {
      /* auditing is best-effort here; auditSafe already reports failures */
    }
  }

  private own(caller: VoiceCaller, sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s || s.connId !== caller.connId) {
      throw new VoiceError("not_found", "unknown voice session");
    }
    return s;
  }

  start(
    caller: VoiceCaller,
    params: { projectId?: string; lang?: VoiceLangRequest; deviceHint?: string },
  ): { sessionId: string } {
    const cfg = this.enabledConfig();
    let mine = 0;
    for (const s of this.sessions.values()) {
      mine += s.connId === caller.connId ? 1 : 0;
    }
    if (mine >= cfg.limits.maxConcurrentSessions || this.sessions.size >= GLOBAL_MAX_SESSIONS) {
      throw new VoiceError("busy", "a voice session is already active");
    }
    const stt = (this.opts.stt ?? createSpeechToText)(cfg);
    const id = randomUUID();
    const lang = params.lang ?? "auto";
    const abort = new AbortController();
    const ephemeral = new EphemeralAudioDir({
      tmpRoot: this.opts.tmpRoot,
      keepDir: cfg.keepAudio ? cfg.keepAudioDir : undefined,
      label: id,
    });
    const stream = stt.open({
      lang,
      signal: abort.signal,
      ephemeral,
      onPartial: (p) => {
        const s = this.sessions.get(id);
        if (!s || abort.signal.aborted) {
          return;
        }
        this.emit(s.connId, "voice.transcript.partial", {
          sessionId: id,
          text: p.text,
          ...(p.lang ? { lang: p.lang } : {}),
        });
      },
    });
    const now = Date.now();
    const session: Session = {
      id,
      connId: caller.connId,
      actor: caller.actor,
      projectId: params.projectId,
      lang,
      adapterId: stt.id,
      stream,
      abort,
      ephemeral,
      startedAt: now,
      nextSeq: 0,
      queuedBytes: 0,
      bytes: 0,
      chunks: 0,
      writes: Promise.resolve(true),
      inflight: new Map(),
      recent: [],
      state: "open",
      closed: false,
      drainMs: cfg.limits.idleTimeoutMs,
      maxTimer: setTimeout(() => void this.finalizeOnLimit(id), cfg.limits.maxSessionMs),
      idleTimer: setTimeout(() => void this.end(id, "idle"), cfg.limits.idleTimeoutMs),
    };
    session.maxTimer.unref?.();
    session.idleTimer.unref?.();
    this.sessions.set(id, session);
    this.audit(caller, "voice.start", "ok", {
      sessionId: id,
      lang,
      adapter: stt.id,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.deviceHint ? { deviceHint: params.deviceHint.slice(0, 64) } : {}),
      keepAudio: cfg.keepAudio,
    });
    return { sessionId: id };
  }

  async audio(
    caller: VoiceCaller,
    params: { sessionId: string; chunk: string; seq: number },
  ): Promise<{ sessionId: string; seq: number; duplicate?: boolean }> {
    const cfg = this.enabledConfig();
    const s = this.own(caller, params.sessionId);
    if (s.state !== "open") {
      throw new VoiceError("invalid", "voice session is no longer accepting audio");
    }
    if (params.seq < s.nextSeq) {
      // A retry of a chunk whose write is still pending answers with that write's outcome, so a
      // duplicate is only ever acknowledged for audio the engine took.
      const pending = s.inflight.get(params.seq);
      if (pending) {
        await pending.catch(() => {
          throw new VoiceError("engine", "speech engine failed");
        });
      }
      return { sessionId: s.id, seq: params.seq, duplicate: true };
    }
    if (params.seq !== s.nextSeq) {
      throw new VoiceError("invalid", `out-of-order audio chunk (expected seq ${s.nextSeq})`);
    }
    const lim = cfg.limits;
    if (params.chunk.length > Math.ceil(lim.maxChunkBytes / 3) * 4 + 4) {
      throw new VoiceError("limit", `audio chunk exceeds ${lim.maxChunkBytes} bytes`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(params.chunk)) {
      throw new VoiceError("invalid", "audio chunk is not base64");
    }
    const pcm = Buffer.from(params.chunk, "base64");
    if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > lim.maxChunkBytes) {
      throw new VoiceError("invalid", "audio chunk must be non-empty PCM16 within the size limit");
    }
    const now = Date.now();
    s.recent = s.recent.filter((t) => now - t < 1000);
    if (s.recent.length >= lim.maxChunksPerSecond) {
      throw new VoiceError("limit", "audio chunk rate exceeded");
    }
    const allowed = (now - s.startedAt + 1000) * VOICE_BYTES_PER_MS * lim.realtimeFactor;
    if (s.queuedBytes + pcm.length > allowed) {
      throw new VoiceError("limit", "audio arrives faster than real time allows");
    }
    if (s.queuedBytes + pcm.length > lim.maxSessionMs * VOICE_BYTES_PER_MS) {
      void this.finalizeOnLimit(s.id);
      throw new VoiceError("limit", "voice session length limit reached");
    }
    s.recent.push(now);
    const seq = params.seq;
    s.nextSeq += 1;
    s.queuedBytes += pcm.length;
    s.idleTimer.refresh();
    // Chained behind the previous write: a chunk reaches the engine only after the one before it
    // was accepted, and nothing is written after a failure.
    const write = s.writes.then(async (ok) => {
      if (!ok || s.closed || s.abort.signal.aborted) {
        throw new VoiceError("engine", "speech engine failed");
      }
      await s.stream.write(pcm);
      // A write that settles after the session ended (a stop timed out, a cancel) is not accepted.
      if (s.closed || s.abort.signal.aborted) {
        throw new VoiceError("engine", "speech engine failed");
      }
      s.bytes += pcm.length;
      s.chunks += 1;
    });
    s.writes = write.then(
      () => true,
      () => false,
    );
    s.inflight.set(seq, write);
    try {
      await write;
    } catch {
      // The seq already advanced, but the chunk never reached the engine: end the session so a
      // retry of this seq is refused instead of being acknowledged as a duplicate of lost audio.
      // A stop already in progress waits for this write and reports the failure itself.
      if (s.state === "open") {
        await this.end(s.id, "error");
      }
      throw new VoiceError("engine", "speech engine failed");
    } finally {
      s.inflight.delete(seq);
    }
    return { sessionId: s.id, seq };
  }

  async stop(caller: VoiceCaller, params: { sessionId: string }): Promise<VoiceTranscriptFinal> {
    const s = this.own(caller, params.sessionId);
    return await this.finalize(s, "stop");
  }

  private async finalizeOnLimit(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.state !== "open") {
      return;
    }
    try {
      await this.finalize(s, "limit");
      this.emit(s.connId, "voice.session.ended", { sessionId, reason: "limit" });
    } catch {
      /* finalize already reported the error */
    }
  }

  private async finalize(s: Session, why: "stop" | "limit"): Promise<VoiceTranscriptFinal> {
    if (s.state !== "open") {
      throw new VoiceError("invalid", "voice session is already stopping");
    }
    s.state = "finishing";
    clearTimeout(s.maxTimer);
    clearTimeout(s.idleTimer);
    let audioMs = 0;
    try {
      // Every admitted chunk must have reached the engine before the transcript is final.
      const drained = await this.bounded(s, s.writes);
      if (!drained.ok || !drained.value) {
        try {
          s.stream.abort();
        } catch {
          /* adapters must not throw here; ignore if one does */
        }
        throw new VoiceError(
          "engine",
          s.abort.signal.aborted ? "voice session was cancelled" : "speech engine failed",
        );
      }
      audioMs = Math.round(s.bytes / VOICE_BYTES_PER_MS);
      const finished = await this.bounded(
        s,
        s.stream.finish().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      );
      if (s.abort.signal.aborted || !this.sessions.has(s.id)) {
        throw new VoiceError("engine", "voice session was cancelled");
      }
      if (!finished.ok) {
        try {
          s.stream.abort();
        } catch {
          /* adapters must not throw here; ignore if one does */
        }
        throw new VoiceError("engine", "speech engine failed");
      }
      if ("error" in finished.value) {
        throw finished.value.error;
      }
      const result = finished.value.value;
      const lang: VoiceLang = result.lang ?? (s.lang === "auto" ? DEFAULT_VOICE_LANG : s.lang);
      const final: VoiceTranscriptFinal = {
        sessionId: s.id,
        text: result.text,
        lang,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      };
      this.emit(s.connId, "voice.transcript.final", final);
      this.audit(s, "voice.stop", "ok", this.stats(s, { reason: why, audioMs, lang }));
      return final;
    } catch (err) {
      const cancelled = s.abort.signal.aborted;
      if (!cancelled) {
        this.emit(s.connId, "voice.session.ended", { sessionId: s.id, reason: "error" });
        audioMs = Math.round(s.bytes / VOICE_BYTES_PER_MS);
        this.audit(s, "voice.stop", "error", this.stats(s, { reason: why, audioMs }));
      }
      throw err instanceof VoiceError ? err : new VoiceError("engine", "speech engine failed");
    } finally {
      s.closed = true;
      this.sessions.delete(s.id);
      await s.ephemeral.dispose().catch(() => undefined);
    }
  }

  /**
   * Wait on the engine for at most drainMs, released at once by a cancel. finalize already cleared
   * the idle timer, so a write or finish the engine never settles must not hold a stop open
   * forever. `p` must never reject; a late result after the timeout or cancel is dropped.
   */
  private bounded<T>(s: Session, p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    return new Promise((resolve) => {
      const done = (r: { ok: true; value: T } | { ok: false }) => {
        clearTimeout(timer);
        s.abort.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => done({ ok: false });
      const timer = setTimeout(() => done({ ok: false }), s.drainMs);
      timer.unref?.();
      if (s.abort.signal.aborted) {
        done({ ok: false });
        return;
      }
      s.abort.signal.addEventListener("abort", onAbort, { once: true });
      void p.then((value) => done({ ok: true, value }));
    });
  }

  private stats(s: Session, extra: object) {
    return {
      sessionId: s.id,
      adapter: s.adapterId,
      chunks: s.chunks,
      bytes: s.bytes,
      durationMs: Date.now() - s.startedAt,
      ...extra,
    };
  }

  /** Abort a session without a transcript (cancel, idle, disconnect, shutdown). */
  private async end(sessionId: string, reason: VoiceEndReason | "cancel"): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return false;
    }
    this.sessions.delete(sessionId);
    s.closed = true;
    clearTimeout(s.maxTimer);
    clearTimeout(s.idleTimer);
    s.abort.abort();
    try {
      s.stream.abort();
    } catch {
      /* adapters must not throw here; ignore if one does */
    }
    await s.ephemeral.dispose().catch(() => undefined);
    if (reason !== "cancel" && reason !== "disconnected" && reason !== "shutdown") {
      this.emit(s.connId, "voice.session.ended", { sessionId, reason });
    }
    this.audit(s, "voice.cancel", "ok", this.stats(s, { reason }));
    return true;
  }

  /** Cancel one session / speech, or everything this connection owns when neither is named. */
  async cancel(
    caller: VoiceCaller,
    params: { sessionId?: string; speakId?: string },
  ): Promise<{ cancelled: string[] }> {
    const cancelled: string[] = [];
    const all = !params.sessionId && !params.speakId;
    for (const s of this.sessions.values()) {
      if (s.connId === caller.connId && (all || s.id === params.sessionId)) {
        if (await this.end(s.id, "cancel")) {
          cancelled.push(s.id);
        }
      }
    }
    for (const sp of this.speaks.values()) {
      if (sp.connId === caller.connId && (all || sp.id === params.speakId)) {
        this.stopSpeak(sp, caller, "cancel");
        cancelled.push(sp.id);
      }
    }
    return { cancelled };
  }

  private stopSpeak(sp: Speak, caller: { actor: string }, reason: string) {
    if (this.speaks.get(sp.id) === sp) {
      this.speaks.delete(sp.id);
      sp.abort.abort();
      this.audit(caller, "voice.speak.cancel", "ok", { speakId: sp.id, reason });
    }
  }

  async speak(
    caller: VoiceCaller,
    params: { text: string; lang: VoiceLang; voice?: string; rate?: number },
  ): Promise<{ speakId: string; format: string }> {
    const cfg = this.enabledConfig();
    const text = params.text.trim();
    const chars = Array.from(text).length;
    if (chars === 0) {
      throw new VoiceError("invalid", "nothing to speak");
    }
    if (chars > cfg.limits.maxSpeakChars) {
      throw new VoiceError("limit", `text exceeds ${cfg.limits.maxSpeakChars} characters`);
    }
    if (params.voice !== undefined && !VOICE_ID.test(params.voice)) {
      throw new VoiceError("invalid", "invalid voice id");
    }
    if (params.rate !== undefined && !(params.rate >= 0.5 && params.rate <= 2)) {
      throw new VoiceError("invalid", "rate must be between 0.5 and 2");
    }
    // One utterance at a time per connection: a new speak replaces the current one.
    for (const sp of this.speaks.values()) {
      if (sp.connId === caller.connId) {
        this.stopSpeak(sp, caller, "replaced");
      }
    }
    const tts = (this.opts.tts ?? createTextToSpeech)(cfg);
    const sp: Speak = { id: randomUUID(), connId: caller.connId, abort: new AbortController() };
    this.speaks.set(sp.id, sp);
    const startedAt = Date.now();
    let result;
    try {
      result = await tts.synthesize({
        text,
        lang: params.lang,
        voice: params.voice,
        rate: params.rate,
        signal: sp.abort.signal,
      });
    } catch (err) {
      this.speaks.delete(sp.id);
      // Replaced, cancelled or disconnected mid-synthesis: stopSpeak already audited the cancel.
      if (sp.abort.signal.aborted) {
        throw new VoiceError("cancelled", "speech was cancelled");
      }
      this.audit(caller, "voice.speak", "error", { speakId: sp.id, lang: params.lang, chars });
      throw err instanceof VoiceError ? err : new VoiceError("engine", "voice engine failed");
    }
    // An engine that ignored the abort: never answer with the speakId of a dead speech.
    if (sp.abort.signal.aborted) {
      closeAudio(result.audio[Symbol.asyncIterator]());
      throw new VoiceError("cancelled", "speech was cancelled");
    }
    // Stream after the method has answered (setImmediate runs after the respond microtask).
    const audio = result.audio;
    setImmediate(() => {
      void this.pump(sp, caller, audio, cfg.limits.outChunkBytes, {
        lang: params.lang,
        chars,
        startedAt,
        adapter: tts.id,
      });
    });
    return { speakId: sp.id, format: result.format };
  }

  private async pump(
    sp: Speak,
    caller: VoiceCaller,
    audio: AsyncIterable<Uint8Array>,
    outChunk: number,
    meta: { lang: VoiceLang; chars: number; startedAt: number; adapter: string },
  ) {
    let seq = 0;
    let bytes = 0;
    let pending = Buffer.alloc(0);
    const send = (chunk: Buffer, done: boolean, error?: string) =>
      this.emit(sp.connId, "voice.audio.out", {
        speakId: sp.id,
        seq: seq++,
        chunk: chunk.toString("base64"),
        done,
        ...(error ? { error } : {}),
      });
    let outcome = "ok";
    // Race each read against the abort so a cancel ends the stream even if the engine ignores it.
    const it = audio[Symbol.asyncIterator]();
    const aborted = new Promise<"aborted">((resolve) => {
      if (sp.abort.signal.aborted) {
        resolve("aborted");
      }
      sp.abort.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      for (;;) {
        const next = it.next();
        next.catch(() => {});
        const step = await Promise.race([next, aborted]);
        if (step === "aborted" || sp.abort.signal.aborted) {
          outcome = "cancelled";
          closeAudio(it);
          break;
        }
        if (step.done) {
          break;
        }
        const part = step.value;
        bytes += part.byteLength;
        pending = Buffer.concat([pending, Buffer.from(part)]);
        while (pending.length >= outChunk) {
          send(pending.subarray(0, outChunk), false);
          pending = pending.subarray(outChunk);
        }
      }
      if (sp.abort.signal.aborted) {
        outcome = "cancelled";
      }
      send(
        outcome === "ok" ? pending : Buffer.alloc(0),
        true,
        outcome === "ok" ? undefined : outcome,
      );
    } catch (err) {
      // An engine that honours the abort by rejecting the pending read was cancelled, not failed.
      if (sp.abort.signal.aborted) {
        outcome = "cancelled";
        closeAudio(it);
        send(Buffer.alloc(0), true, outcome);
      } else {
        outcome = "error";
        send(
          Buffer.alloc(0),
          true,
          err instanceof VoiceError ? err.message : "voice engine failed",
        );
      }
    } finally {
      if (this.speaks.get(sp.id) === sp) {
        this.speaks.delete(sp.id);
      }
      this.audit(caller, "voice.speak", outcome, {
        speakId: sp.id,
        adapter: meta.adapter,
        lang: meta.lang,
        chars: meta.chars,
        bytes,
        durationMs: Date.now() - meta.startedAt,
      });
    }
  }

  /** The socket closed: drop every session and speech it owned. */
  async closeConnection(connId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.connId === connId) {
        await this.end(s.id, "disconnected");
      }
    }
    for (const sp of this.speaks.values()) {
      if (sp.connId === connId) {
        this.stopSpeak(sp, { actor: "system" }, "disconnected");
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of this.sessions.keys()) {
      await this.end(id, "shutdown");
    }
    for (const sp of this.speaks.values()) {
      this.stopSpeak(sp, { actor: "system" }, "shutdown");
    }
  }
}
