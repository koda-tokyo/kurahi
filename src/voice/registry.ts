// Adapter registry. Built-ins: `local-cli` (STT), `local-http` (TTS) and `fake` (both). Plugins
// may register more (including cloud adapters); admins pick one per direction in config.
//
// Cloud adapters: the registry only holds the factory. A factory that declares
// `locality: "cloud"` is refused unless `voice.cloud.allow` is true, before it is ever invoked,
// so a cloud adapter cannot open a connection while the opt-in is off. No cloud adapter ships
// in the box.
import type { ResolvedVoiceConfig } from "./config.js";
import type { SpeechToText, TextToSpeech, VoiceLocality } from "./types.js";
import { createFakeSpeechToText, createFakeTextToSpeech } from "./adapters/fake.js";
import { createLocalCliSpeechToText } from "./adapters/local-cli-stt.js";
import { createLocalHttpTextToSpeech } from "./adapters/local-http-tts.js";
import { VoiceError } from "./types.js";

export type AdapterFactory<T> = {
  locality: VoiceLocality;
  /** Builds the adapter from the resolved config (adapter options: `voice.adapterOptions[id]`). */
  create: (cfg: ResolvedVoiceConfig, options: Record<string, unknown>) => T;
};

export type SpeechToTextFactory = AdapterFactory<SpeechToText>;
export type TextToSpeechFactory = AdapterFactory<TextToSpeech>;

const sttFactories = new Map<string, SpeechToTextFactory>();
const ttsFactories = new Map<string, TextToSpeechFactory>();

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerSpeechToText(id: string, factory: SpeechToTextFactory): void {
  if (!ID.test(id)) {
    throw new Error(`invalid voice adapter id: ${id}`);
  }
  sttFactories.set(id, factory);
}

export function registerTextToSpeech(id: string, factory: TextToSpeechFactory): void {
  if (!ID.test(id)) {
    throw new Error(`invalid voice adapter id: ${id}`);
  }
  ttsFactories.set(id, factory);
}

/** Removes a registered adapter (tests, plugin unload). Built-ins are re-registered on reset. */
export function unregisterVoiceAdapter(id: string): void {
  sttFactories.delete(id);
  ttsFactories.delete(id);
}

export function listVoiceAdapters(): {
  stt: Array<{ id: string; locality: VoiceLocality }>;
  tts: Array<{ id: string; locality: VoiceLocality }>;
} {
  const rows = (m: Map<string, AdapterFactory<unknown>>) =>
    [...m].map(([id, f]) => ({ id, locality: f.locality }));
  return { stt: rows(sttFactories), tts: rows(ttsFactories) };
}

function build<T>(
  kind: "speech-to-text" | "text-to-speech",
  factories: Map<string, AdapterFactory<T>>,
  id: string,
  cfg: ResolvedVoiceConfig,
): T {
  const factory = factories.get(id);
  if (!factory) {
    throw new VoiceError("unavailable", `${kind} adapter is not available`);
  }
  if (factory.locality === "cloud" && !cfg.cloudAllowed) {
    throw new VoiceError("refused", `${kind} adapter is a cloud adapter; voice.cloud.allow is off`);
  }
  return factory.create(cfg, cfg.raw.adapterOptions?.[id] ?? {});
}

export function createSpeechToText(cfg: ResolvedVoiceConfig): SpeechToText {
  return build("speech-to-text", sttFactories, cfg.sttAdapter, cfg);
}

export function createTextToSpeech(cfg: ResolvedVoiceConfig): TextToSpeech {
  return build("text-to-speech", ttsFactories, cfg.ttsAdapter, cfg);
}

export function registerBuiltinVoiceAdapters(): void {
  registerSpeechToText("local-cli", {
    locality: "local",
    create: (cfg) => createLocalCliSpeechToText(cfg.raw.stt?.localCli),
  });
  registerSpeechToText("fake", {
    locality: "local",
    create: (cfg) => createFakeSpeechToText({ autoLang: cfg.raw.stt?.fake?.autoLang }),
  });
  registerTextToSpeech("local-http", {
    locality: "local",
    create: (cfg) => createLocalHttpTextToSpeech(cfg.raw.tts?.localHttp),
  });
  registerTextToSpeech("fake", { locality: "local", create: () => createFakeTextToSpeech() });
}

registerBuiltinVoiceAdapters();
