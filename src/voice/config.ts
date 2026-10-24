// Resolves `voice.*` config into a complete settings object with safe defaults.
import type { VoiceConfig } from "../config/types.voice.js";
import type { VoiceLang } from "./types.js";

export type ResolvedVoiceLimits = {
  maxSessionMs: number;
  maxChunkBytes: number;
  maxChunksPerSecond: number;
  realtimeFactor: number;
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  maxSpeakChars: number;
  outChunkBytes: number;
};

export type ResolvedVoiceConfig = {
  enabled: boolean;
  sttAdapter: string;
  ttsAdapter: string;
  cloudAllowed: boolean;
  limits: ResolvedVoiceLimits;
  keepAudio: boolean;
  keepAudioDir?: string;
  raw: VoiceConfig;
};

export const DEFAULT_VOICE_LIMITS: ResolvedVoiceLimits = {
  maxSessionMs: 120_000,
  maxChunkBytes: 64_000,
  maxChunksPerSecond: 50,
  realtimeFactor: 4,
  maxConcurrentSessions: 1,
  idleTimeoutMs: 20_000,
  maxSpeakChars: 2_000,
  outChunkBytes: 32_768,
};

export const DEFAULT_STT_ADAPTER = "local-cli";
export const DEFAULT_TTS_ADAPTER = "local-http";
/** Language used when `auto` is requested and the engine does not report one. */
export const DEFAULT_VOICE_LANG: VoiceLang = "ja";

export function resolveVoiceConfig(cfg: VoiceConfig | undefined): ResolvedVoiceConfig {
  const raw = cfg ?? {};
  const limits = { ...DEFAULT_VOICE_LIMITS };
  for (const [key, value] of Object.entries(raw.limits ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      (limits as Record<string, number>)[key] = value;
    }
  }
  // keepAudio is honoured only with an explicit directory (the schema enforces it as well).
  const keepAudio = raw.privacy?.keepAudio === true && Boolean(raw.privacy.keepAudioDir);
  return {
    enabled: raw.enabled === true,
    sttAdapter: raw.stt?.adapter ?? DEFAULT_STT_ADAPTER,
    ttsAdapter: raw.tts?.adapter ?? DEFAULT_TTS_ADAPTER,
    cloudAllowed: raw.cloud?.allow === true,
    limits,
    keepAudio,
    keepAudioDir: keepAudio ? raw.privacy?.keepAudioDir : undefined,
    raw,
  };
}
