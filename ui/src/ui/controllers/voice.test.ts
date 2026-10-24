import { describe, expect, it, vi } from "vitest";
import {
  cancelVoice,
  emptyVoice,
  startVoice,
  stopVoice,
  voiceEvent,
  type VoiceCapture,
  type VoiceHost,
} from "./voice";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup() {
  let write!: (chunk: string) => Promise<void>;
  let failed!: () => void;
  const capture: VoiceCapture = {
    start: vi.fn(async (next, error) => {
      write = next;
      failed = error;
    }),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
  const request = vi.fn(async (method: string) => {
    if (method === "voice.start") {
      return { sessionId: "voice-1" };
    }
    if (method === "voice.stop") {
      return { sessionId: "voice-1", text: "Draft", lang: "en" };
    }
    return {};
  });
  const host: VoiceHost = {
    client: { request } as unknown as VoiceHost["client"],
    connected: true,
    voice: emptyVoice(),
    voiceCapture: () => capture,
  };
  return {
    host,
    capture,
    request,
    write: (chunk = "AAA=") => write(chunk),
    failed: () => failed(),
  };
}
describe("native voice adapter controller", () => {
  it("does nothing without native capture or a connection", async () => {
    const s = setup();
    s.host.voiceCapture = null;
    await startVoice(s.host, "p1", "en");
    expect(s.request).not.toHaveBeenCalled();
    s.host.voiceCapture = () => s.capture;
    s.host.connected = false;
    await startVoice(s.host, "p1", "en");
    expect(s.capture.start).not.toHaveBeenCalled();
  });
  it("streams sequentially and flushes capture before requesting a transcript", async () => {
    const s = setup();
    const audio = deferred<{}>();
    s.request.mockImplementation(async (method) =>
      method === "voice.audio"
        ? audio.promise
        : method === "voice.start"
          ? { sessionId: "voice-1" }
          : { sessionId: "voice-1", text: "Draft", lang: "en" },
    );
    await startVoice(s.host, "p1", "ja");
    expect(s.request).toHaveBeenCalledWith("voice.start", { projectId: "p1", lang: "ja" });
    const first = s.write();
    const second = s.write();
    const stopped = stopVoice(s.host);
    await Promise.resolve();
    expect(s.request.mock.calls.filter(([m]) => m === "voice.audio")).toHaveLength(1);
    expect(s.request.mock.calls.some(([m]) => m === "voice.stop")).toBe(false);
    audio.resolve({});
    await Promise.all([first, second, stopped]);
    expect(s.request).toHaveBeenCalledWith("voice.audio", {
      sessionId: "voice-1",
      chunk: "AAA=",
      seq: 0,
    });
    expect(s.request).toHaveBeenCalledWith("voice.audio", {
      sessionId: "voice-1",
      chunk: "AAA=",
      seq: 1,
    });
    expect(s.capture.stop).toHaveBeenCalledOnce();
    expect(s.host.voice).toMatchObject({ phase: "ready", text: "Draft" });
    expect(s.request.mock.calls.every(([m]) => m.startsWith("voice."))).toBe(true);
  });
  it("deduplicates final events and stop responses without overwriting edits", async () => {
    const s = setup();
    const result = deferred<{ sessionId: string; text: string; lang: string }>();
    s.request.mockImplementation(async (m) =>
      m === "voice.stop" ? result.promise : { sessionId: "voice-1" },
    );
    await startVoice(s.host, "p1", "en");
    const stopped = stopVoice(s.host);
    await Promise.resolve();
    await Promise.resolve();
    voiceEvent(s.host, "voice.transcript.final", { sessionId: "voice-1", text: "Original" });
    s.host.voice = { ...s.host.voice, text: "Edited" };
    voiceEvent(s.host, "voice.transcript.partial", { sessionId: "voice-1", text: "Late" });
    voiceEvent(s.host, "voice.transcript.final", { sessionId: "voice-1", text: "Duplicate" });
    result.resolve({ sessionId: "voice-1", text: "Original", lang: "en" });
    await stopped;
    expect(s.host.voice.text).toBe("Edited");
  });
  it("cancels a session that finishes starting after navigation", async () => {
    const s = setup();
    const start = deferred<{ sessionId: string }>();
    s.request.mockImplementation(async (m) => (m === "voice.start" ? start.promise : {}));
    const starting = startVoice(s.host, "p1", "en");
    cancelVoice(s.host);
    start.resolve({ sessionId: "voice-late" });
    await starting;
    expect(s.capture.start).not.toHaveBeenCalled();
    expect(s.request).toHaveBeenCalledWith("voice.cancel", { sessionId: "voice-late" });
    expect(s.host.voice).toEqual(emptyVoice());
  });
  it("discards delayed events after cancellation and ignores other sessions", async () => {
    const s = setup();
    await startVoice(s.host, "p1", "en");
    voiceEvent(s.host, "voice.transcript.partial", { sessionId: "other", text: "Private" });
    expect(s.host.voice.text).toBe("");
    cancelVoice(s.host);
    voiceEvent(s.host, "voice.transcript.final", { sessionId: "voice-1", text: "Late" });
    expect(s.host.voice).toEqual(emptyVoice());
    expect(s.capture.cancel).toHaveBeenCalled();
  });
  it.each(["idle", "error", "limit"])("releases capture on server end: %s", async (reason) => {
    const s = setup();
    await startVoice(s.host, "p1", "en");
    voiceEvent(s.host, "voice.session.ended", { sessionId: "voice-1", reason });
    expect(s.host.voice.phase).toBe("error");
    expect(s.capture.cancel).toHaveBeenCalled();
  });
  it("preserves the final transcript when the server reaches its length limit", async () => {
    const s = setup();
    await startVoice(s.host, "p1", "en");
    voiceEvent(s.host, "voice.transcript.final", { sessionId: "voice-1", text: "At limit" });
    voiceEvent(s.host, "voice.session.ended", { sessionId: "voice-1", reason: "limit" });
    expect(s.host.voice).toMatchObject({ phase: "ready", text: "At limit" });
  });
  it("stops on failed audio, clears partial text and never sends queued audio or stop", async () => {
    const s = setup();
    s.request.mockImplementation(async (m) => {
      if (m === "voice.audio") {
        throw Error("sensitive backend details");
      }
      return { sessionId: "voice-1" };
    });
    await startVoice(s.host, "p1", "en");
    voiceEvent(s.host, "voice.transcript.partial", { sessionId: "voice-1", text: "Partial" });
    await Promise.all([s.write(), s.write()]);
    await stopVoice(s.host);
    expect(s.host.voice).toMatchObject({ phase: "error", text: "" });
    expect(s.request.mock.calls.filter(([m]) => m === "voice.audio")).toHaveLength(1);
    expect(s.request.mock.calls.some(([m]) => m === "voice.stop")).toBe(false);
  });
  it("releases capture after microphone failure and refuses a second start", async () => {
    const s = setup();
    await startVoice(s.host, "p1", "en");
    await startVoice(s.host, "p2", "en");
    expect(s.capture.start).toHaveBeenCalledOnce();
    s.failed();
    expect(s.host.voice.phase).toBe("error");
    expect(s.capture.cancel).toHaveBeenCalled();
  });
  it("fails closed on oversized chunks", async () => {
    const s = setup();
    await startVoice(s.host, "p1", "en");
    await expect(s.write("A".repeat(85340))).rejects.toThrow("limit");
    expect(s.host.voice.phase).toBe("error");
    expect(s.request.mock.calls.some(([m]) => m === "voice.audio")).toBe(false);
  });
  it("keeps an edited final transcript when pending audio or native cleanup fails late", async () => {
    const s = setup();
    const audio = deferred<{}>();
    s.request.mockImplementation(async (m) =>
      m === "voice.audio" ? audio.promise : { sessionId: "voice-1" },
    );
    await startVoice(s.host, "p1", "en");
    const write = s.write();
    await Promise.resolve();
    voiceEvent(s.host, "voice.transcript.final", { sessionId: "voice-1", text: "Final" });
    s.host.voice = { ...s.host.voice, text: "Edited" };
    audio.reject(Error("Session ended"));
    await write;
    s.failed();
    expect(s.host.voice).toMatchObject({ phase: "ready", text: "Edited" });
  });
});
