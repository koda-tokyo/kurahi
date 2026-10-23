---
summary: "Push-to-talk voice for the Work Console: gateway voice.* methods, local-first speech adapters, limits, and the privacy and approval rules"
read_when:
  - Enabling push-to-talk (Japanese / English) for the desktop Work Console
  - Configuring the local speech-to-text engine or the loopback voice engine
  - Reviewing what voice stores, sends and audits
  - Building a client against the voice.* gateway methods
title: "Voice (push-to-talk)"
---

# Voice (push-to-talk)

The desktop Work Console can dictate in Japanese and English. The user holds the talk key, the
native layer captures audio and streams it to the gateway, partial transcripts appear while they
speak, and when they release the key a final transcript lands in the composer. **The user edits
the text and sends it as an ordinary chat message.** Voice never sends, runs or approves anything
by itself.

Voice is **off by default**. Admins enable it and choose the speech adapters in config; the product
UI never shows adapter, vendor or model names.

## Gateway methods

All methods need the `attach` scope (legacy: `operator.write`). Events go **only to the
connection that owns the session** (they are never broadcast).

| Method         | Params                                                     | Result                                 |
| -------------- | ---------------------------------------------------------- | -------------------------------------- |
| `voice.start`  | `{projectId?, lang?: "ja" \| "en" \| "auto", deviceHint?}` | `{sessionId}`                          |
| `voice.audio`  | `{sessionId, chunk, seq}`                                  | `{sessionId, seq, duplicate?}`         |
| `voice.stop`   | `{sessionId}`                                              | `{sessionId, text, lang, confidence?}` |
| `voice.speak`  | `{text, lang: "ja" \| "en", voice?, rate?}`                | `{speakId, format}`                    |
| `voice.cancel` | `{sessionId?, speakId?}`                                   | `{cancelled: string[]}`                |

- `chunk` is base64 of signed 16-bit little-endian PCM, mono, 16 kHz. `seq` starts at 0 and
  increases by one per chunk; a repeated `seq` is acknowledged as a duplicate and ignored (safe
  retries), a gap is refused. A chunk refused for its size, format or rate does not advance `seq`,
  so it can be resent. If the engine fails to take a chunk, the session ends with
  `voice.session.ended` `reason: "error"` and later `voice.audio` calls answer not found: a
  chunk that was lost is never acknowledged as a duplicate. Start a new session to retry.
  Chunks reach the engine one at a time in `seq` order. A retry of a chunk whose write is still
  pending answers with that write's outcome, and `voice.stop` waits for every pending chunk: if
  one fails, there is no `voice.transcript.final`, only `voice.session.ended` `reason: "error"`.
- `voice.cancel` without ids cancels every session and speech the connection owns.
- `voice.speak` answers first, then streams the audio. A new `voice.speak` on the same connection
  replaces the one still playing. A speech replaced, cancelled or disconnected before it answers
  fails with `details.voice: "cancelled"` (never as an engine error, never with a `speakId`). A
  cancel ends a playing speech at once with its `done` event (`error: "cancelled"`), whether the
  engine ignores the abort or answers it by failing the read.
- `voice.stop` waits for every accepted chunk to reach the engine, then for the transcript. Each
  wait is bounded by `idleTimeoutMs`: a chunk or transcript the engine has not settled by then
  fails the stop as an engine error (one `voice.session.ended` reason `error`, one `voice.stop`
  error audit); a `voice.cancel` releases a waiting stop at once. Once a session ended, queued
  chunks never reach the engine and a write that settles late is never acknowledged.

| Event                      | Payload                                             |
| -------------------------- | --------------------------------------------------- |
| `voice.transcript.partial` | `{sessionId, text, lang?}`                          |
| `voice.transcript.final`   | `{sessionId, text, lang, confidence?}`              |
| `voice.audio.out`          | `{seq, chunk, done, speakId?, error?}`              |
| `voice.session.ended`      | `{sessionId, reason: "limit" \| "idle" \| "error"}` |

`voice.transcript.final` is sent once per session, before `voice.stop` answers. `lang` is the
language the engine reported when it reports one (the detection hook); otherwise the requested
language, and for `auto` without engine detection, Japanese. The last `voice.audio.out` of a speech
has `done: true` and an empty `chunk`; `error` is set when it ended early (`"cancelled"` or an
engine error). `voice.session.ended` reports a server-side end: the session hit its length limit
(a final transcript is sent first), went idle, or the engine failed.

Schemas: `VoiceStartParams`, `VoiceAudioParams`, … in `dist/protocol.schema.json` and the WebSocket
section of `openapi/kolo-gateway.openapi.json`.

Native capture belongs to the desktop (Tauri) layer. The webview never gets generic media access;
it only receives transcripts and audio through these events.

## Configuration

```json5
{
  voice: {
    enabled: true,
    stt: {
      adapter: "local-cli",
      localCli: {
        binary: "/opt/whisper.cpp/build/bin/whisper-cli",
        args: [
          "-m",
          "/opt/models/ggml-large-v3-turbo.bin",
          "-f",
          "{input}",
          "-l",
          "{lang}",
          "-nt",
          "-np",
          "-oj",
          "-of",
          "{outputBase}",
        ],
        timeoutMs: 60000,
      },
    },
    tts: {
      adapter: "local-http",
      localHttp: { url: "http://127.0.0.1:17493/v1/speak" },
    },
  },
}
```

| Key                                    | Default                        | Meaning                                                |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `voice.enabled`                        | `false`                        | Every `voice.*` method answers UNAVAILABLE until true. |
| `voice.stt.adapter`                    | `local-cli`                    | `local-cli`, `fake`, or a registered adapter id.       |
| `voice.stt.localCli.binary`            | —                              | Absolute path of a whisper.cpp-compatible CLI.         |
| `voice.stt.localCli.args`              | `-f {input} -l {lang} -nt -np` | Argument vector; must contain `{input}`.               |
| `voice.stt.localCli.timeoutMs`         | `60000`                        | The engine is killed after this.                       |
| `voice.stt.localCli.maxOutputBytes`    | `262144`                       | Cap on engine stdout / stderr.                         |
| `voice.stt.localCli.env`               | —                              | Extra environment (merged over PATH, HOME, LANG only). |
| `voice.tts.adapter`                    | `local-http`                   | `local-http`, `fake`, or a registered adapter id.      |
| `voice.tts.localHttp.url`              | —                              | The in-house voice engine. Loopback only by default.   |
| `voice.tts.localHttp.allowNonLoopback` | `false`                        | Explicit opt-in for a non-loopback host.               |
| `voice.tts.localHttp.timeoutMs`        | `30000`                        | Per synthesis.                                         |
| `voice.tts.localHttp.maxResponseBytes` | `16777216`                     | Cap on audio accepted from the engine.                 |
| `voice.cloud.allow`                    | `false`                        | Cloud adapters refuse to load until true.              |
| `voice.adapterOptions.<id>`            | —                              | Options handed to a registered adapter.                |
| `voice.privacy.keepAudio`              | `false`                        | Keep captured audio (needs `keepAudioDir`).            |
| `voice.privacy.keepAudioDir`           | —                              | Absolute directory for kept audio.                     |

### Local speech-to-text (`local-cli`)

The engine is spawned directly with the configured argv — **never through a shell**. Placeholders
are substituted inside each argument and never split it, so nothing client-supplied can become an
extra argument:

- `{input}` — the utterance as a 16 kHz mono WAV in a private temp dir
- `{lang}` — `ja`, `en` or `auto`
- `{outputBase}` — a path prefix in the same dir; `{outputBase}.json` is read when present
  (whisper.cpp `-oj -of`), and its `result.language` is reported as the detected language

Otherwise stdout is parsed: a JSON object `{text, lang | language, confidence?}`, or plain text
(whisper.cpp timestamps are stripped). Stderr is counted against the cap but never stored or
logged. The engine is a batch engine, so this adapter sends no partial transcripts; the final
arrives after the key is released.

### Local text-to-speech (`local-http`)

`POST <url>` with `{"text", "lang", "voice"?, "rate"?}`; the response body is streamed back as
`voice.audio.out` chunks and its `Content-Type` is returned as `format`. The URL must name a
loopback host (`127.0.0.0/8`, `::1`, `localhost`) unless `allowNonLoopback` is true; URLs with
credentials are refused, redirects are refused (a loopback engine cannot bounce the request
off-host), and timeout and size caps apply.

### Fake adapters (`fake`)

Deterministic adapters for tests and demos: each audio chunk reveals one more word of a fixed
Japanese or English phrase as a partial; speech returns a fixed PCM pattern (20 ms per character).
No engine, network or disk.

### Cloud adapters

None ship in the box. A plugin can register one with `registerSpeechToText` /
`registerTextToSpeech` (`src/voice/registry.ts`) declaring `locality: "cloud"`. The registry
refuses to build it — its factory is never called, so it cannot open a connection — unless an
admin sets `voice.cloud.allow: true` and selects it in `voice.stt.adapter` / `voice.tts.adapter`.
Its options come from `voice.adapterOptions.<id>`. Enabling a cloud adapter sends user audio or
text off the machine; record that decision with your data-handling review.

## Limits

| Key                                  | Default  | Effect                                                                 |
| ------------------------------------ | -------- | ---------------------------------------------------------------------- |
| `voice.limits.maxSessionMs`          | `120000` | Wall clock and audio length; the session is finalised at the limit.    |
| `voice.limits.maxChunkBytes`         | `64000`  | Decoded bytes per `voice.audio` chunk (≈ 2 s).                         |
| `voice.limits.maxChunksPerSecond`    | `50`     | Chunk rate per session.                                                |
| `voice.limits.realtimeFactor`        | `4`      | Audio may arrive at most this much faster than real time (+1 s burst). |
| `voice.limits.maxConcurrentSessions` | `1`      | Per connection.                                                        |
| `voice.limits.idleTimeoutMs`         | `20000`  | A session with no audio for this long is cancelled.                    |
| `voice.limits.maxSpeakChars`         | `2000`   | Characters per `voice.speak`.                                          |
| `voice.limits.outChunkBytes`         | `32768`  | Size of one `voice.audio.out` chunk before base64.                     |

Chunks must be non-empty, valid base64 and an even number of bytes (PCM16). Refusals answer
`INVALID_REQUEST` with `details.voice` set to `limit`, `invalid`, `busy`, … (`limit` and `busy`
are marked retryable); a disabled or unavailable engine answers `UNAVAILABLE`.

## Security and privacy

- **Off by default.** Nothing listens for audio until an admin sets `voice.enabled: true`.
- **Local first.** The built-in adapters run on this machine: a CLI engine on disk and a voice
  engine on loopback. Cloud adapters need a separate admin opt-in (`voice.cloud.allow`).
- **Audio is ephemeral.** Audio is held in memory for the session and zeroed after use. When the
  engine needs a file, the WAV is written as a `0600` file inside a private `0700` temp directory,
  and the directory is deleted when the session ends — after a final transcript, a cancel, an
  idle timeout, an engine error, a disconnect or a gateway shutdown.
- **Keeping audio is an explicit opt-in.** Only `voice.privacy.keepAudio: true` together with an
  absolute `voice.privacy.keepAudioDir` keeps audio; files are copied there as `0600`
  (`<sessionId>-audio-N.wav`). Either key alone keeps nothing.
- **Transcripts are stored only as chat messages.** The gateway does not persist transcripts. The
  user's edited text becomes a normal chat message, with the same storage, retention and access
  rules as anything typed.
- **Private events.** Transcripts and audio are sent only to the connection that started the
  session; other connections cannot feed, stop or cancel it, even with the same token.
- **Audit without content.** `voice.start`, `voice.stop`, `voice.cancel`, `voice.speak` and
  `voice.speak.cancel` are written to the audit log with session id, language, adapter id,
  byte / chunk / character counts, durations and the outcome. Never audio, never transcript text,
  never the text that was spoken.

### Consequential actions are never approved by voice

A transcript is only ever text in the composer. **No approval can be given by voice**:

- Every approval-type gateway method — `exec.approval.resolve`, `exec.approvals.set`,
  `exec.approvals.node.set`, `pair.approve`, `pair.invite`, `device.pair.approve`,
  `node.pair.approve`, `policy.release`, `artifacts.setStatus`, and any future `*.approve` method —
  refuses a request that carries a voice-origin marker (`origin` / `inputMode` / `source` / `via`
  naming voice or speech, or a `voice`, `voiceOrigin`, `voiceSessionId`, `fromVoice`, `byVoice`,
  `spoken` or `transcript` field, also inside `meta` / `context` / `client` / `origin`). The check
  runs in the gateway dispatcher before schema validation and before the handler
  (`src/voice/approval-guard.ts`).
- The `voice.*` methods themselves cannot approve, run or send anything.
- The Work Console must render approvals as explicit click or keyboard confirmations and must
  never map a spoken "yes" / 「承認」 to an approval call.

## Limitations

- The `local-cli` adapter is batch-only: no partial transcripts. Partials need a streaming adapter
  (the `fake` adapter shows the flow).
- `lang: "auto"` relies on the engine reporting a language; without one the session reports
  Japanese.
- Only PCM16 mono 16 kHz input is accepted; resampling is the native layer's job.
- HTTP approval routes are not covered by the voice-origin guard (their bodies are strict schemas
  without such fields); the Work Console uses the WebSocket methods.
