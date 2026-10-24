// Speech adapter contracts (Work Console push-to-talk).
//
// An adapter turns PCM16 mono 16 kHz audio into text (SpeechToText) or text into audio
// (TextToSpeech). Adapters are chosen by admins in `voice.*` config and looked up in the registry
// (registry.ts); the product UI only ever sees the transcript and the audio, never an adapter,
// vendor or model name.

/** Languages the Work Console supports. */
export type VoiceLang = "ja" | "en";
/** What a client may request: a language, or `auto` (engine detection, else the default). */
export type VoiceLangRequest = VoiceLang | "auto";

/** Where the adapter's audio goes. `cloud` adapters load only with `voice.cloud.allow: true`. */
export type VoiceLocality = "local" | "cloud";

/** Input audio format of every session: signed 16-bit little-endian PCM, mono, 16 kHz. */
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000; // 32 bytes per millisecond

export type SttPartial = { text: string; lang?: VoiceLang };

export type SttFinal = {
  text: string;
  /** Language reported by the engine, when it reports one (the detection hook). */
  lang?: VoiceLang;
  /** 0..1 when the engine reports one. */
  confidence?: number;
};

export type SttOpenOptions = {
  lang: VoiceLangRequest;
  /** Aborted on cancel, disconnect, timeout or gateway shutdown. */
  signal: AbortSignal;
  /** Called with interim hypotheses; adapters without partials never call it. */
  onPartial: (partial: SttPartial) => void;
  /**
   * Privacy hook: the adapter hands over any temp file it wrote; the session deletes it (or keeps
   * it when an admin opted in) when the session ends. Adapters must not write audio elsewhere.
   */
  ephemeral: EphemeralAudio;
};

/** One push-to-talk utterance inside an adapter. */
export interface SttStream {
  /** Raw PCM16 bytes, in order. May emit partials through `onPartial`. */
  write(pcm: Buffer): void | Promise<void>;
  /** No more audio: produce the final transcript. */
  finish(): Promise<SttFinal>;
  /** Drop everything; must not throw. */
  abort(): void;
}

export interface SpeechToText {
  readonly id: string;
  readonly locality: VoiceLocality;
  open(opts: SttOpenOptions): SttStream;
}

export type TtsRequest = {
  text: string;
  lang: VoiceLang;
  /** Opaque voice id the admin configured; adapters ignore what they do not know. */
  voice?: string;
  /** Speaking rate multiplier (0.5–2.0). */
  rate?: number;
  signal: AbortSignal;
};

export type TtsResult = {
  /** Media type of the audio stream, e.g. `audio/wav` or `audio/L16;rate=16000;channels=1`. */
  format: string;
  audio: AsyncIterable<Uint8Array>;
};

export interface TextToSpeech {
  readonly id: string;
  readonly locality: VoiceLocality;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/** Temp-file broker for adapters that need audio on disk (see ephemeral.ts). */
export interface EphemeralAudio {
  /** Writes `pcm` as a WAV file (0600) in a private 0700 temp dir and returns its path. */
  writeWav(pcm: Buffer): Promise<string>;
  /** A path prefix inside the same private dir for engine output files. */
  outputBase(): Promise<string>;
}

export class VoiceError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "unavailable"
      | "invalid"
      | "limit"
      | "not_found"
      | "busy"
      | "engine"
      | "refused"
      | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}
