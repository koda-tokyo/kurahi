// Deterministic fake speech adapters for tests and demos. No engine, no network, no disk.
//
// STT: every written chunk reveals one more word of a fixed per-language phrase (a partial), and
// `finish` returns the words revealed so far as the final transcript (confidence 0.99).
// TTS: returns `ceil(text.length) * 640` bytes of a fixed PCM16 pattern (20 ms per character).
import type {
  SpeechToText,
  SttFinal,
  SttOpenOptions,
  SttStream,
  TextToSpeech,
  TtsRequest,
  TtsResult,
  VoiceLang,
} from "../types.js";

export const FAKE_PHRASES: Record<VoiceLang, string[]> = {
  ja: ["今日の", "会議の", "議事録を", "まとめて", "ください"],
  en: ["please", "summarise", "the", "meeting", "notes"],
};

function joinWords(lang: VoiceLang, words: string[]): string {
  return lang === "ja" ? words.join("") : words.join(" ");
}

export function fakeTranscript(lang: VoiceLang, chunks: number): string {
  const phrase = FAKE_PHRASES[lang];
  const words: string[] = [];
  for (let i = 0; i < chunks; i++) {
    words.push(phrase[i % phrase.length]);
  }
  return joinWords(lang, words);
}

export function createFakeSpeechToText(opts: { autoLang?: VoiceLang } = {}): SpeechToText {
  return {
    id: "fake",
    locality: "local",
    open(open: SttOpenOptions): SttStream {
      const lang: VoiceLang = open.lang === "auto" ? (opts.autoLang ?? "en") : open.lang;
      let chunks = 0;
      let aborted = false;
      return {
        write(pcm: Buffer) {
          if (aborted || pcm.length === 0) {
            return;
          }
          chunks += 1;
          open.onPartial({ text: fakeTranscript(lang, chunks), lang });
        },
        async finish(): Promise<SttFinal> {
          if (aborted || open.signal.aborted) {
            throw new Error("aborted");
          }
          return { text: fakeTranscript(lang, chunks), lang, confidence: 0.99 };
        },
        abort() {
          aborted = true;
        },
      };
    },
  };
}

export const FAKE_TTS_FORMAT = "audio/L16;rate=16000;channels=1";
export const FAKE_TTS_BYTES_PER_CHAR = 640;

export function createFakeTextToSpeech(): TextToSpeech {
  return {
    id: "fake",
    locality: "local",
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const total = Array.from(req.text).length * FAKE_TTS_BYTES_PER_CHAR;
      async function* audio() {
        const block = 4096;
        for (let off = 0; off < total; off += block) {
          if (req.signal.aborted) {
            return;
          }
          const n = Math.min(block, total - off);
          const buf = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            buf[i] = (off + i) & 0xff;
          }
          yield buf;
          // Yield to the event loop so cancel can land between blocks.
          await new Promise((r) => setImmediate(r));
        }
      }
      return { format: FAKE_TTS_FORMAT, audio: audio() };
    },
  };
}
