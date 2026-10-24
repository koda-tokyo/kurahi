// Voice adapter configuration (Kurahi Work Console push-to-talk). Everything is off by default and
// every field is admin-only: the product UI never shows adapter, vendor or model names.
//
//   voice.enabled                       false
//   voice.stt.adapter                   "local-cli" | "fake" | <registered adapter id>
//   voice.stt.localCli                  binary (absolute path), args (argv template), timeoutMs, …
//   voice.tts.adapter                   "local-http" | "fake" | <registered adapter id>
//   voice.tts.localHttp                 url (loopback only unless allowNonLoopback), timeoutMs, …
//   voice.cloud.allow                   false — cloud adapters refuse to load until an admin opts in
//   voice.limits                        session length, chunk size, chunk rate, speak length
//   voice.privacy.keepAudio             false — audio is ephemeral unless an admin opts in
//
// See docs/tools/voice.md.

export type VoiceLangCode = "ja" | "en";

export type VoiceLocalCliSttConfig = {
  /** Absolute path of a whisper.cpp-compatible CLI. Spawned directly, never through a shell. */
  binary?: string;
  /**
   * Argument vector. Placeholders (replaced inside each argument, never re-split):
   * `{input}` WAV path, `{lang}` ja|en|auto, `{outputBase}` path prefix for engine output files
   * (`{outputBase}.json` is read when present).
   */
  args?: string[];
  /** Hard timeout for one transcription (default 60 000 ms). */
  timeoutMs?: number;
  /** Cap on stdout/stderr bytes read from the engine (default 262 144). */
  maxOutputBytes?: number;
  /** Extra environment for the child (merged over PATH/HOME/LANG only). */
  env?: Record<string, string>;
};

export type VoiceLocalHttpTtsConfig = {
  /** Endpoint of the in-house voice engine, e.g. http://127.0.0.1:17493/v1/speak. */
  url?: string;
  /** Allow a non-loopback host. Off by default; an admin must opt in explicitly. */
  allowNonLoopback?: boolean;
  /** Hard timeout for one synthesis (default 30 000 ms). */
  timeoutMs?: number;
  /** Cap on audio bytes accepted from the engine (default 16 MiB). */
  maxResponseBytes?: number;
};

export type VoiceFakeConfig = {
  /** Language the fake engine "detects" when the request is `auto` (default "en"). */
  autoLang?: VoiceLangCode;
};

export type VoiceLimitsConfig = {
  /** Maximum length of one push-to-talk session (default 120 000 ms). */
  maxSessionMs?: number;
  /** Maximum decoded bytes of one `voice.audio` chunk (default 64 000 ≈ 2 s of PCM16 16 kHz). */
  maxChunkBytes?: number;
  /** Maximum `voice.audio` chunks per second per session (default 50). */
  maxChunksPerSecond?: number;
  /** Audio may arrive at most this many times faster than real time (default 4). */
  realtimeFactor?: number;
  /** Concurrent sessions per connection (default 1). */
  maxConcurrentSessions?: number;
  /** A session with no audio for this long is cancelled (default 20 000 ms). */
  idleTimeoutMs?: number;
  /** Maximum characters of one `voice.speak` text (default 2 000). */
  maxSpeakChars?: number;
  /** Size of one `voice.audio.out` chunk before base64 (default 32 768). */
  outChunkBytes?: number;
};

export type VoicePrivacyConfig = {
  /** Keep captured audio after a session. Off by default; needs `keepAudioDir` as well. */
  keepAudio?: boolean;
  /** Absolute directory for kept audio (files 0600). Required when keepAudio is true. */
  keepAudioDir?: string;
};

export type VoiceConfig = {
  enabled?: boolean;
  stt?: {
    adapter?: string;
    localCli?: VoiceLocalCliSttConfig;
    fake?: VoiceFakeConfig;
  };
  tts?: {
    adapter?: string;
    localHttp?: VoiceLocalHttpTtsConfig;
  };
  cloud?: {
    /** Cloud STT/TTS adapters (registered by plugins) load only when true. */
    allow?: boolean;
  };
  /** Options for registered (non built-in) adapters, by adapter id. */
  adapterOptions?: Record<string, Record<string, unknown>>;
  limits?: VoiceLimitsConfig;
  privacy?: VoicePrivacyConfig;
};
