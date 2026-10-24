import type {
  VoiceStartResult,
  VoiceStopResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";

/** Native desktop integration only. Never substitute browser media access. */
export type VoiceCapture = {
  // Resolve after capture starts; deliver PCM16 LE, mono, 16 kHz, awaiting each write.
  start: (write: (pcmBase64: string) => Promise<void>, failed: () => void) => Promise<void>;
  // Flush the last chunk and resolve only once no more writes can arrive.
  stop: () => Promise<void>;
  // Immediately stop capture, discard buffered audio and release the microphone.
  cancel: () => void;
};
export type VoiceState = {
  phase: "idle" | "starting" | "recording" | "stopping" | "ready" | "error";
  projectId: string | null;
  sessionId: string | null;
  text: string;
};
export const emptyVoice = (): VoiceState => ({
  phase: "idle",
  projectId: null,
  sessionId: null,
  text: "",
});
export type VoiceHost = {
  client: Pick<GatewayBrowserClient, "request"> | null;
  connected: boolean;
  voice: VoiceState;
  // Each call owns an independent capture handle, including during cancelled startup.
  voiceCapture: (() => VoiceCapture) | null;
};
type Run = {
  client: NonNullable<VoiceHost["client"]>;
  capture: VoiceCapture;
  sessionId: string | null;
  seq: number;
  queue: Promise<void>;
  pending: number;
  final: boolean;
};
const runs = new WeakMap<VoiceHost, Run>();
function patch(host: VoiceHost, next: Partial<VoiceState>) {
  host.voice = { ...host.voice, ...next };
}
function cancelRemote(run: Run) {
  if (run.sessionId) {
    void run.client.request("voice.cancel", { sessionId: run.sessionId }).catch(() => {});
  }
}
function release(run: Run) {
  try {
    run.capture.cancel();
  } catch {
    /* Cleanup must not block state reset. */
  }
}
export function cancelVoice(host: VoiceHost) {
  const run = runs.get(host);
  runs.delete(host);
  if (run) {
    release(run);
    cancelRemote(run);
  }
  if (host.voice) {
    host.voice = emptyVoice();
  }
}
function fail(host: VoiceHost, run: Run) {
  if (runs.get(host) !== run || run.final) {
    return;
  }
  runs.delete(host);
  release(run);
  cancelRemote(run);
  patch(host, { phase: "error", sessionId: null, text: "" });
}
export async function startVoice(host: VoiceHost, projectId: string, lang: "ja" | "en") {
  if (!host.connected || !host.client || !host.voiceCapture || runs.has(host)) {
    return;
  }
  let capture: VoiceCapture;
  try {
    capture = host.voiceCapture();
  } catch {
    host.voice = { ...emptyVoice(), projectId, phase: "error" };
    return;
  }
  const run: Run = {
    client: host.client,
    capture,
    sessionId: null,
    seq: 0,
    queue: Promise.resolve(),
    pending: 0,
    final: false,
  };
  runs.set(host, run);
  host.voice = { ...emptyVoice(), projectId, phase: "starting" };
  try {
    const result = await run.client.request<VoiceStartResult>("voice.start", { projectId, lang });
    run.sessionId = result.sessionId;
    if (runs.get(host) !== run) {
      cancelRemote(run);
      return;
    }
    patch(host, { sessionId: result.sessionId });
    await run.capture.start(
      (chunk) => {
        if (runs.get(host) !== run || run.final) {
          return Promise.resolve();
        }
        // Bound memory even if a native adapter violates the backpressure contract.
        if (++run.pending > 8 || chunk.length > 85336 || !chunk.length) {
          fail(host, run);
          return Promise.reject(new Error("Voice capture limit"));
        }
        const write = run.queue.then(async () => {
          if (runs.get(host) !== run || run.final) {
            return;
          }
          await run.client.request("voice.audio", {
            sessionId: run.sessionId,
            chunk,
            seq: run.seq++,
          });
        });
        run.queue = write
          .catch(() => {
            fail(host, run);
          })
          .finally(() => {
            run.pending--;
          });
        return run.queue;
      },
      () => fail(host, run),
    );
    if (runs.get(host) !== run) {
      release(run);
      return;
    }
    // A final or limit event may have arrived while native startup was settling.
    if (run.final) {
      release(run);
      return;
    }
    patch(host, { phase: "recording" });
  } catch {
    fail(host, run);
  }
}
function finalTranscript(host: VoiceHost, run: Run, text: string) {
  if (run.final) {
    return;
  }
  run.final = true;
  release(run);
  patch(host, { phase: "ready", text: text.slice(0, 100000) });
}
export async function stopVoice(host: VoiceHost) {
  const run = runs.get(host);
  if (!run || host.voice.phase !== "recording") {
    return;
  }
  patch(host, { phase: "stopping" });
  try {
    await run.capture.stop();
    await run.queue;
    if (runs.get(host) !== run || run.final) {
      return;
    }
    const result = await run.client.request<VoiceStopResult>("voice.stop", {
      sessionId: run.sessionId,
    });
    if (runs.get(host) === run && result.sessionId === run.sessionId) {
      finalTranscript(host, run, result.text);
    }
  } catch {
    if (!run.final) {
      fail(host, run);
    }
  }
}
export function voiceEvent(host: VoiceHost, event: string, payload: unknown) {
  const run = runs.get(host);
  if (!run || !payload || typeof payload !== "object") {
    return;
  }
  const value = payload as { sessionId?: unknown; text?: unknown; reason?: unknown };
  if (!run.sessionId || value.sessionId !== run.sessionId) {
    return;
  }
  if (event === "voice.transcript.final" && typeof value.text === "string") {
    finalTranscript(host, run, value.text);
  } else if (event === "voice.transcript.partial" && typeof value.text === "string" && !run.final) {
    patch(host, { text: value.text.slice(0, 100000) });
  } else if (event === "voice.session.ended" && !run.final) {
    fail(host, run);
  }
}
