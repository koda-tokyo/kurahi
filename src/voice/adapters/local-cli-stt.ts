// Local speech-to-text through a whisper.cpp-compatible command line engine.
//
// Safety: the binary is an absolute path from admin config and is spawned directly (no shell);
// the argv is the admin template with placeholders substituted inside each argument, so audio,
// language or anything client-supplied can never become an extra argument. A hard timeout and
// stdout/stderr byte caps bound the run. Audio is written to the session's private temp dir only
// for the run (see ephemeral.ts) and removed when the session ends.
//
// Batch engine: no partial transcripts. The language reported by the engine (whisper.cpp JSON
// `result.language`, or `lang` / `language` in a JSON stdout) is returned as the detection hook.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { VoiceLocalCliSttConfig } from "../../config/types.voice.js";
import type { SpeechToText, SttFinal, SttOpenOptions, SttStream, VoiceLang } from "../types.js";
import { VoiceError } from "../types.js";

export const DEFAULT_CLI_TIMEOUT_MS = 60_000;
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_ARGS = ["-f", "{input}", "-l", "{lang}", "-nt", "-np"];

export function normalizeLang(raw: unknown): VoiceLang | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if (v === "ja" || v === "japanese" || v.startsWith("ja-") || v.startsWith("ja_")) {
    return "ja";
  }
  if (v === "en" || v === "english" || v.startsWith("en-") || v.startsWith("en_")) {
    return "en";
  }
  return undefined;
}

/** Substitute placeholders inside each argument; never splits or adds arguments. */
export function buildArgv(template: string[], values: Record<string, string>): string[] {
  return template.map((arg) =>
    arg.replace(/\{(input|lang|outputBase)\}/g, (_m, key: string) => values[key] ?? ""),
  );
}

const TIMESTAMP =
  /^\s*\[\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\]\s*/;

function joinSegments(parts: string[], lang: VoiceLang | undefined): string {
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  return (lang === "ja" ? cleaned.join("") : cleaned.join(" ")).trim();
}

/** Parse engine output: whisper.cpp JSON, a generic JSON object, or plain text. */
export function parseEngineOutput(
  stdout: string,
  json: unknown,
  requested: VoiceLang | undefined,
): SttFinal {
  const obj = (json ?? tryJson(stdout)) as Record<string, unknown> | null;
  if (obj && typeof obj === "object") {
    const result = obj.result as Record<string, unknown> | undefined;
    const lang = normalizeLang(result?.language ?? obj.lang ?? obj.language);
    let text = "";
    if (Array.isArray(obj.transcription)) {
      text = joinSegments(
        obj.transcription.map((s) => segmentText(s)),
        lang ?? requested,
      );
    } else if (typeof obj.text === "string") {
      text = obj.text.trim();
    }
    const conf = typeof obj.confidence === "number" ? obj.confidence : undefined;
    return {
      text,
      ...(lang ? { lang } : {}),
      ...(conf !== undefined && conf >= 0 && conf <= 1 ? { confidence: conf } : {}),
    };
  }
  const lines = stdout.split(/\r?\n/).map((l) => l.replace(TIMESTAMP, ""));
  return { text: joinSegments(lines, requested) };
}

function segmentText(segment: unknown): string {
  const text = (segment as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

type RunResult = { code: number | null; stdout: string };

function runEngine(
  binary: string,
  argv: string[],
  cfg: VoiceLocalCliSttConfig,
  signal: AbortSignal,
): Promise<RunResult> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxBytes = cfg.maxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        LANG: "C.UTF-8",
        ...cfg.env,
      },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: VoiceError | null = null;
    const kill = (err: VoiceError) => {
      failure ??= err;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => kill(new VoiceError("engine", "speech engine timed out")),
      timeoutMs,
    );
    const onAbort = () => kill(new VoiceError("engine", "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > maxBytes) {
        kill(new VoiceError("engine", "speech engine output too large"));
        return;
      }
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      // Never stored or logged (it can echo audio-derived text); only counted.
      errBytes += b.length;
      if (errBytes > maxBytes) {
        kill(new VoiceError("engine", "speech engine output too large"));
      }
    });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      reject(new VoiceError("unavailable", `speech engine failed to start (${err.message})`));
    });
    child.on("close", (code) => {
      done();
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8") });
    });
  });
}

export function createLocalCliSpeechToText(cfg: VoiceLocalCliSttConfig = {}): SpeechToText {
  const binary = cfg.binary;
  if (!binary || !path.isAbsolute(binary)) {
    throw new VoiceError("unavailable", "voice.stt.localCli.binary must be an absolute path");
  }
  const template = cfg.args?.length ? cfg.args : DEFAULT_ARGS;
  if (!template.some((a) => a.includes("{input}"))) {
    throw new VoiceError("unavailable", "voice.stt.localCli.args must reference {input}");
  }
  return {
    id: "local-cli",
    locality: "local",
    open(open: SttOpenOptions): SttStream {
      const chunks: Buffer[] = [];
      let aborted = false;
      return {
        write(pcm: Buffer) {
          if (!aborted) {
            chunks.push(pcm);
          }
        },
        async finish(): Promise<SttFinal> {
          const pcm = Buffer.concat(chunks);
          for (const c of chunks) {
            c.fill(0);
          }
          chunks.length = 0;
          try {
            if (aborted || open.signal.aborted) {
              throw new VoiceError("engine", "aborted");
            }
            if (pcm.length === 0) {
              return { text: "" };
            }
            const input = await open.ephemeral.writeWav(pcm);
            const outputBase = await open.ephemeral.outputBase();
            const argv = buildArgv(template, { input, lang: open.lang, outputBase });
            const run = await runEngine(binary, argv, cfg, open.signal);
            if (run.code !== 0) {
              throw new VoiceError("engine", `speech engine exited with code ${run.code}`);
            }
            let json: unknown = null;
            if (template.some((a) => a.includes("{outputBase}"))) {
              json = await fs
                .readFile(`${outputBase}.json`, "utf8")
                .then((t) => JSON.parse(t) as unknown)
                .catch(() => null);
            }
            const requested = open.lang === "auto" ? undefined : open.lang;
            return parseEngineOutput(run.stdout, json, requested);
          } finally {
            pcm.fill(0);
          }
        },
        abort() {
          aborted = true;
          for (const c of chunks) {
            c.fill(0);
          }
          chunks.length = 0;
        },
      };
    },
  };
}
