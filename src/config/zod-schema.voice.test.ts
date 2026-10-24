import { describe, expect, it } from "vitest";
import { KoLoSchema } from "./zod-schema.js";

describe("voice config schema", () => {
  it("accepts a local-first setup and leaves voice off when absent", () => {
    expect(KoLoSchema.safeParse({}).success).toBe(true);
    const ok = KoLoSchema.safeParse({
      voice: {
        enabled: true,
        stt: {
          adapter: "local-cli",
          localCli: { binary: "/opt/whisper/whisper-cli", args: ["-f", "{input}", "-l", "{lang}"] },
        },
        tts: { adapter: "local-http", localHttp: { url: "http://127.0.0.1:17493/v1/speak" } },
        limits: { maxSessionMs: 60_000 },
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a relative binary, keepAudio without a directory and unknown keys", () => {
    const bad = (voice: unknown) => KoLoSchema.safeParse({ voice }).success;
    expect(bad({ stt: { localCli: { binary: "whisper-cli" } } })).toBe(false);
    expect(bad({ privacy: { keepAudio: true } })).toBe(false);
    expect(bad({ privacy: { keepAudio: true, keepAudioDir: "/var/lib/kurahi/voice" } })).toBe(true);
    expect(bad({ stt: { model: "x" } })).toBe(false);
    expect(bad({ tts: { localHttp: { url: "ftp://127.0.0.1/" } } })).toBe(false);
  });
});
