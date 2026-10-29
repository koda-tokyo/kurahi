import type { AddressInfo } from "node:net";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildArgv,
  createLocalCliSpeechToText,
  normalizeLang,
  parseEngineOutput,
} from "./adapters/local-cli-stt.js";
import {
  assertEngineUrl,
  createLocalHttpTextToSpeech,
  isLoopbackHostname,
} from "./adapters/local-http-tts.js";
import { resolveVoiceConfig } from "./config.js";
import { EphemeralAudioDir } from "./ephemeral.js";
import {
  createSpeechToText,
  createTextToSpeech,
  registerSpeechToText,
  unregisterVoiceAdapter,
} from "./registry.js";

async function collect(audio: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of audio) {
    parts.push(Buffer.from(p));
  }
  return Buffer.concat(parts);
}

describe("local TTS adapter: loopback only", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "[::1]", "::ffff:127.0.0.1"])("accepts %s", (h) =>
    expect(isLoopbackHostname(h)).toBe(true),
  );
  it.each(["10.0.0.5", "0.0.0.0", "example.com", "127.0.0.1.nip.io", "[::]", "100.95.60.1"])(
    "rejects %s",
    (h) => expect(isLoopbackHostname(h)).toBe(false),
  );

  it("refuses a non-loopback URL unless allowNonLoopback is set", () => {
    expect(() => assertEngineUrl("http://192.168.1.20:9000/speak", false)).toThrow(/loopback/);
    expect(() => createLocalHttpTextToSpeech({ url: "https://tts.example.com/v1" })).toThrow(
      /loopback/,
    );
    expect(assertEngineUrl("http://192.168.1.20:9000/speak", true).hostname).toBe("192.168.1.20");
    expect(() => assertEngineUrl("http://user:pw@127.0.0.1/", false)).toThrow(/credentials/);
    expect(() => assertEngineUrl("file:///etc/passwd", true)).toThrow(/http/);
    expect(() => assertEngineUrl(undefined, false)).toThrow(/not configured/);
  });

  describe("against a loopback engine", () => {
    let server: http.Server | null = null;
    afterEach(async () => {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = null;
    });

    async function listen(handler: http.RequestListener): Promise<string> {
      server = http.createServer(handler);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/speak`;
    }

    it("posts {text, lang, voice, rate} and streams the audio with its content type", async () => {
      let body = "";
      const url = await listen((req, res) => {
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "audio/wav" });
          res.write(Buffer.alloc(1000, 7));
          res.end(Buffer.alloc(500, 8));
        });
      });
      const tts = createLocalHttpTextToSpeech({ url });
      const out = await tts.synthesize({
        text: "おはよう",
        lang: "ja",
        voice: "house-a",
        rate: 1.2,
        signal: new AbortController().signal,
      });
      expect(out.format).toBe("audio/wav");
      expect((await collect(out.audio)).length).toBe(1500);
      expect(JSON.parse(body)).toEqual({
        text: "おはよう",
        lang: "ja",
        voice: "house-a",
        rate: 1.2,
      });
    });

    it("refuses redirects and caps the response size", async () => {
      const url = await listen((req, res) => {
        if (req.url === "/speak") {
          res.writeHead(302, { location: "http://example.com/" });
          res.end();
          return;
        }
        const headers: Record<string, string> = { "content-type": "audio/wav" };
        if (req.url === "/declared") {
          headers["content-length"] = "4096";
        }
        res.writeHead(200, headers);
        res.end(Buffer.alloc(4096));
      });
      const signal = new AbortController().signal;
      await expect(
        createLocalHttpTextToSpeech({ url }).synthesize({ text: "x", lang: "en", signal }),
      ).rejects.toThrow(/unreachable/);
      const big = createLocalHttpTextToSpeech({
        url: url.replace("/speak", "/big"),
        maxResponseBytes: 1024,
      });
      // Chunked: refused while streaming.
      const streamed = await big.synthesize({ text: "x", lang: "en", signal });
      await expect(collect(streamed.audio)).rejects.toThrow(/too large/);
      // Declared Content-Length: refused up front.
      const declared = createLocalHttpTextToSpeech({
        url: url.replace("/speak", "/declared"),
        maxResponseBytes: 1024,
      });
      await expect(declared.synthesize({ text: "x", lang: "en", signal })).rejects.toThrow(
        /too large/,
      );
    });
  });
});

describe("local STT adapter", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("substitutes placeholders inside arguments without splitting them", () => {
    expect(
      buildArgv(["-f", "{input}", "--lang={lang}", "-of", "{outputBase}"], {
        input: "/tmp/a b.wav",
        lang: "ja",
        outputBase: "/tmp/out",
      }),
    ).toEqual(["-f", "/tmp/a b.wav", "--lang=ja", "-of", "/tmp/out"]);
  });

  it("parses whisper.cpp JSON, generic JSON and timestamped text", () => {
    expect(
      parseEngineOutput(
        "",
        { result: { language: "ja" }, transcription: [{ text: " こんにちは" }, { text: "世界" }] },
        undefined,
      ),
    ).toEqual({ text: "こんにちは世界", lang: "ja" });
    expect(
      parseEngineOutput('{"text":" hi ","lang":"en-US","confidence":0.8}', null, "ja"),
    ).toEqual({ text: "hi", lang: "en", confidence: 0.8 });
    expect(
      parseEngineOutput(
        "[00:00:00.000 --> 00:00:01.000]  hello\n[00:00:01.000 --> 00:00:02.000]  there\n",
        null,
        "en",
      ),
    ).toEqual({ text: "hello there" });
    expect(normalizeLang("Japanese")).toBe("ja");
    expect(normalizeLang("fr")).toBeUndefined();
  });

  it("requires an absolute binary and an {input} argument", () => {
    expect(() => createLocalCliSpeechToText({ binary: "whisper-cli" })).toThrow(/absolute/);
    expect(() =>
      createLocalCliSpeechToText({ binary: process.execPath, args: ["-m", "model.bin"] }),
    ).toThrow(/\{input\}/);
  });

  it("kills an engine that exceeds its timeout and removes the temp audio", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cli-"));
    dirs.push(root);
    const hang = path.join(root, "hang.cjs");
    fs.writeFileSync(hang, "setInterval(() => {}, 1000);");
    const stt = createLocalCliSpeechToText({
      binary: process.execPath,
      args: [hang, "{input}"],
      timeoutMs: 1000,
    });
    const ephemeral = new EphemeralAudioDir({ tmpRoot: root, label: "t" });
    const stream = stt.open({
      lang: "en",
      signal: new AbortController().signal,
      onPartial: () => {},
      ephemeral,
    });
    await stream.write(Buffer.alloc(320));
    await expect(stream.finish()).rejects.toThrow(/timed out/);
    const dir = await ephemeral.currentDir();
    expect(dir && fs.existsSync(dir)).toBe(true);
    await ephemeral.dispose();
    expect(fs.existsSync(dir!)).toBe(false);
  });
});

describe("adapter registry", () => {
  afterEach(() => unregisterVoiceAdapter("cloudy"));

  it("selects adapters from config and refuses cloud adapters until an admin opts in", () => {
    let created = 0;
    registerSpeechToText("cloudy", {
      locality: "cloud",
      create: () => {
        created += 1;
        return { id: "cloudy", locality: "cloud", open: () => ({}) as never };
      },
    });
    expect(createSpeechToText(resolveVoiceConfig({ stt: { adapter: "fake" } })).id).toBe("fake");
    expect(() => createSpeechToText(resolveVoiceConfig({ stt: { adapter: "cloudy" } }))).toThrow(
      /cloud/,
    );
    expect(created).toBe(0);
    const ok = createSpeechToText(
      resolveVoiceConfig({ stt: { adapter: "cloudy" }, cloud: { allow: true } }),
    );
    expect(ok.locality).toBe("cloud");
    expect(() => createTextToSpeech(resolveVoiceConfig({ tts: { adapter: "nope" } }))).toThrow(
      /not available/,
    );
  });
});
