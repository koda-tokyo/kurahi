// Local text-to-speech through the in-house voice engine on loopback.
//
// POST <url> with JSON {text, lang, voice?, rate?}; the response body is the audio stream and its
// Content-Type is passed through as the format. The URL must point at a loopback host unless an
// admin sets `allowNonLoopback: true`; redirects are refused (so a loopback engine cannot bounce
// the request off-host), and timeout and response-size caps bound every call.
import type { VoiceLocalHttpTtsConfig } from "../../config/types.voice.js";
import type { TextToSpeech, TtsRequest, TtsResult } from "../types.js";
import { VoiceError } from "../types.js";

export const DEFAULT_TTS_TIMEOUT_MS = 30_000;
export const DEFAULT_TTS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** True for 127.0.0.0/8, ::1 (bracketed or not), ::ffff:127.x and `localhost`. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  const parts = v4.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/** Validates the engine URL; throws VoiceError("refused") for a non-loopback host. */
export function assertEngineUrl(raw: string | undefined, allowNonLoopback: boolean): URL {
  if (!raw) {
    throw new VoiceError("unavailable", "voice.tts.localHttp.url is not configured");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VoiceError("unavailable", "voice.tts.localHttp.url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VoiceError("unavailable", "voice.tts.localHttp.url must be http(s)");
  }
  if (url.username || url.password) {
    throw new VoiceError("refused", "voice.tts.localHttp.url must not carry credentials");
  }
  if (!allowNonLoopback && !isLoopbackHostname(url.hostname)) {
    throw new VoiceError(
      "refused",
      "voice.tts.localHttp.url must be a loopback address (set allowNonLoopback to opt in)",
    );
  }
  return url;
}

export function createLocalHttpTextToSpeech(
  cfg: VoiceLocalHttpTtsConfig = {},
  fetchImpl: typeof fetch = fetch,
): TextToSpeech {
  const url = assertEngineUrl(cfg.url, cfg.allowNonLoopback === true);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const maxBytes = cfg.maxResponseBytes ?? DEFAULT_TTS_MAX_RESPONSE_BYTES;
  return {
    id: "local-http",
    locality: "local",
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([req.signal, timeout]);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "audio/*" },
          body: JSON.stringify({
            text: req.text,
            lang: req.lang,
            ...(req.voice ? { voice: req.voice } : {}),
            ...(req.rate !== undefined ? { rate: req.rate } : {}),
          }),
          redirect: "error",
          signal,
        });
      } catch (err) {
        if (req.signal.aborted) {
          throw new VoiceError("engine", "aborted");
        }
        throw new VoiceError(
          "unavailable",
          timeout.aborted ? "voice engine timed out" : `voice engine unreachable (${String(err)})`,
        );
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new VoiceError("engine", `voice engine answered ${res.status}`);
      }
      const len = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(len) && len > maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new VoiceError("limit", "voice engine response too large");
      }
      const format = res.headers.get("content-type")?.split(",")[0]?.trim() || "audio/wav";
      const body = res.body;
      async function* audio() {
        const reader = body.getReader();
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              return;
            }
            total += value.byteLength;
            if (total > maxBytes) {
              throw new VoiceError("limit", "voice engine response too large");
            }
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      return { format, audio: audio() };
    },
  };
}
