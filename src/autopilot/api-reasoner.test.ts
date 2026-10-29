import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { Reasoner, ReasonRequest } from "./reasoner.js";
import {
  API_REASONER_MAX_RESPONSE_BYTES,
  createApiReasoner,
  createRoutingReasoner,
  OLLAMA_MAX_CONTEXT,
  OLLAMA_MIN_CONTEXT,
  ollamaContextFor,
  resolveApiEndpoint,
} from "./api-reasoner.js";
import { ReasonerToolUse } from "./reasoner.js";

const req = (over: Partial<ReasonRequest> = {}): ReasonRequest => ({
  prompt: "plan this",
  backend: "api",
  model: "sakura/gpt-oss-120b",
  timeoutMs: 5000,
  runId: "r1",
  routineId: "x",
  ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const key = async () => "sk-test-SECRET";
const message = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));
const ok = (content: unknown, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { role: "assistant", content, ...extra } }],
});

describe("api reasoner", () => {
  it("calls the provider's chat completions with no tools and returns the text", async () => {
    const calls: Call[] = [];
    const r = createApiReasoner(
      {},
      { fetch: fakeFetch(200, ok('{"items":[]}'), calls), apiKey: key },
    );
    const out = await r.reason(req());
    expect(out).toEqual({ text: '{"items":[]}', backend: "api", model: "sakura/gpt-oss-120b" });
    expect(calls[0].url).toBe("https://api.ai.sakura.ad.jp/v1/chat/completions");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "plan this" }],
      temperature: 0,
      stream: false,
    });
    expect("tools" in body || "tool_choice" in body).toBe(false);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test-SECRET",
    );
  });

  it("joins text parts", async () => {
    const r = createApiReasoner(
      {},
      {
        fetch: fakeFetch(
          200,
          ok([
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ]),
        ),
        apiKey: key,
      },
    );
    expect((await r.reason(req())).text).toBe("ab");
  });

  it("discards a reply with tool calls", async () => {
    const r = createApiReasoner(
      {},
      { fetch: fakeFetch(200, ok("", { tool_calls: [{ id: "t" }] })), apiKey: key },
    );
    await expect(r.reason(req())).rejects.toBeInstanceOf(ReasonerToolUse);
  });

  it("discards a reply with a legacy function call, even next to a usable answer", async () => {
    const r = createApiReasoner(
      {},
      {
        fetch: fakeFetch(
          200,
          ok('{"items":[]}', { function_call: { name: "run", arguments: "{}" } }),
        ),
        apiKey: key,
      },
    );
    await expect(r.reason(req())).rejects.toBeInstanceOf(ReasonerToolUse);
  });

  it("refuses an answer a content filter stopped instead of returning part of it", async () => {
    const cut = {
      choices: [
        {
          message: { role: "assistant", content: '{"items":[{"id":1' },
          finish_reason: "content_filter",
        },
      ],
    };
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, cut), apiKey: key }).reason(req()),
    ).rejects.toThrow(/stopped by the provider's content filter/);
  });

  it("reports the model's refusal instead of returning its text or 'no answer'", async () => {
    const refused = ok(null, { refusal: "I can't help with that." });
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, refused), apiKey: key }).reason(req()),
    ).rejects.toThrow(/refused: I can't help with that\.$/);
    const both = ok('{"items":[]}', { refusal: "I can't help with that." });
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, both), apiKey: key }).reason(req()),
    ).rejects.toThrow(/refused/);
    const none = ok('{"items":[]}', { refusal: null });
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, none), apiKey: key }).reason(req()),
    ).resolves.toMatchObject({ text: '{"items":[]}' });
  });

  it("drops a leading <think> block instead of returning it as part of the plan", async () => {
    const plan = '{"items":[]}';
    const thought = ok(
      `<think>\nThe reply must be {"items":[...]}; nothing to do.\n</think>\n\n${plan}`,
    );
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, thought), apiKey: key }).reason(req()),
    ).resolves.toMatchObject({ text: plan });
    const onlyThought = ok("<think>Nothing to plan.</think>\n");
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, onlyThought), apiKey: key }).reason(req()),
    ).rejects.toThrow(/returned no answer/);
    // Only a leading block: the same tag inside the answer is the model's text.
    const inside = ok('{"items":[{"title":"<think>x</think>"}]}');
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, inside), apiKey: key }).reason(req()),
    ).resolves.toMatchObject({ text: '{"items":[{"title":"<think>x</think>"}]}' });
  });

  it("refuses an answer cut off at the token limit instead of returning part of it", async () => {
    const cut = {
      choices: [
        { message: { role: "assistant", content: '{"items":[{"id":1' }, finish_reason: "length" },
      ],
    };
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, cut), apiKey: key }).reason(req()),
    ).rejects.toThrow(/cut off at the token limit/);
    const done = { choices: [{ ...cut.choices[0], finish_reason: "stop" }] };
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, done), apiKey: key }).reason(req()),
    ).resolves.toMatchObject({ text: '{"items":[{"id":1' });
  });

  it("reports provider errors without the key, and empty or non-JSON replies", async () => {
    const r = createApiReasoner({}, { fetch: fakeFetch(429, { error: "quota" }), apiKey: key });
    const err = await r.reason(req()).catch((e: Error) => e);
    expect(message(err)).toMatch(/returned 429/);
    expect(message(err)).not.toContain("SECRET");
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, ok("  ")), apiKey: key }).reason(req()),
    ).rejects.toThrow(/no answer/);
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, "<html>"), apiKey: key }).reason(req()),
    ).rejects.toThrow(/not JSON/);
  });

  it("redacts the key when a provider's error text echoes it", async () => {
    const echo = { error: { message: "Invalid API key: sk-test-SECRET (Bearer sk-test-SECRET)" } };
    const err = await createApiReasoner({}, { fetch: fakeFetch(401, echo), apiKey: key })
      .reason(req())
      .catch((e: Error) => e);
    expect(message(err)).toMatch(/returned 401: .*Invalid API key: \[redacted\]/);
    expect(message(err)).not.toContain("SECRET");
  });

  it("refuses a key with a line break or control character without quoting it", async () => {
    // fetch's own error for such a header quotes it whole: `Headers.append: "Bearer …" is an
    // invalid header value`. Building the Request reproduces it without a network call.
    const calls: Call[] = [];
    const strict = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      new Request(url, init);
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    for (const bad of ["sk-test-SEC\nRET", "sk-test-SEC\u0000RET", "sk-test-SEC\rRET"]) {
      const err = await createApiReasoner({}, { fetch: strict, apiKey: async () => bad })
        .reason(req())
        .catch((e: Error) => e);
      expect(message(err)).toMatch(/API key for sakura contains a line break or control character/);
      expect(message(err)).not.toContain("SEC");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a key with a non-ASCII character instead of sending or garbling it", async () => {
    // A zero-width space or a full-width letter (an IME paste) makes fetch throw "Cannot convert
    // argument to a ByteString…"; a Latin-1 letter is sent as a mangled byte and comes back as 401.
    const calls: Call[] = [];
    const strict = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      new Request(url, init);
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    for (const bad of ["sk-test-SEC​RET", "sk-test-ＳＥＣRET", "sk-test-SECéRET"]) {
      const err = await createApiReasoner({}, { fetch: strict, apiKey: async () => bad })
        .reason(req())
        .catch((e: Error) => e);
      expect(message(err)).toMatch(
        /API key for sakura contains a character that is not plain ASCII/,
      );
      expect(message(err)).not.toContain("SEC");
    }
    expect(calls).toHaveLength(0);
  });

  it("reports an error sent with status 200 instead of choices, without the key", async () => {
    const midstream = { error: { message: "upstream overloaded for key sk-test-SECRET" } };
    const err = await createApiReasoner({}, { fetch: fakeFetch(200, midstream), apiKey: key })
      .reason(req())
      .catch((e: Error) => e);
    expect(message(err)).toMatch(/returned an error: upstream overloaded for key \[redacted\]/);
    expect(message(err)).not.toContain("SECRET");
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, { error: "busy" }), apiKey: key }).reason(
        req(),
      ),
    ).rejects.toThrow(/returned an error: busy/);
  });

  it("reports a JSON reply that is not an object as such, not as a TypeError", async () => {
    for (const body of ["null", "42", '"text"']) {
      const err = await createApiReasoner({}, { fetch: fakeFetch(200, body), apiKey: key })
        .reason(req())
        .catch((e: Error) => e);
      expect(err).not.toBeInstanceOf(TypeError);
      expect(message(err)).toMatch(/not a chat completion/);
    }
  });

  it("times out a reply whose body stalls after the headers", async () => {
    const stalled = (async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"choices":'));
          init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const r = createApiReasoner({}, { fetch: stalled, apiKey: key });
    await expect(r.reason(req({ timeoutMs: 1000 }))).rejects.toThrow(/timed out after 1000 ms/);
  });

  it("refuses an oversized reply while reading it, not after buffering all of it", async () => {
    let pulled = 0;
    const endless = (async () => {
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += chunk.length;
          c.enqueue(chunk);
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const r = createApiReasoner({}, { fetch: endless, apiKey: key });
    await expect(r.reason(req({ timeoutMs: 60_000 }))).rejects.toThrow(
      `larger than ${API_REASONER_MAX_RESPONSE_BYTES} bytes`,
    );
    expect(pulled).toBeLessThan(API_REASONER_MAX_RESPONSE_BYTES + 256 * 1024);
  });

  it("counts the reply cap in bytes, not characters", async () => {
    // 3 bytes per character: under the cap in characters, over it in bytes.
    const wide = "あ".repeat(Math.ceil(API_REASONER_MAX_RESPONSE_BYTES / 3) + 1);
    const r = createApiReasoner({}, { fetch: fakeFetch(200, wide), apiKey: key });
    await expect(r.reason(req())).rejects.toThrow(/larger than/);
  });

  it("does not follow a redirect, so the prompt and key go only to the checked base URL", async () => {
    const listen = (handler: Parameters<typeof createServer>[0]) =>
      new Promise<{ server: Server; url: string }>((resolve) => {
        const server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve({ server, url: `http://127.0.0.1:${port}` });
        });
      });
    const elsewhere: string[] = [];
    const target = await listen((inbound, out) => {
      let body = "";
      inbound.on("data", (c) => (body += c));
      inbound.on("end", () => {
        elsewhere.push(`${inbound.headers.authorization ?? ""} ${body}`);
        out.end(JSON.stringify(ok("from elsewhere")));
      });
    });
    const provider = await listen((_inbound, out) => {
      out.writeHead(307, { location: `${target.url}/v1/chat/completions` }).end();
    });
    try {
      const cfg = {
        models: { providers: { x: { baseUrl: `${provider.url}/v1`, models: [] } } },
      } as unknown as KoLoConfig;
      const r = createApiReasoner(cfg, { apiKey: key });
      await expect(r.reason(req({ model: "x/m" }))).rejects.toThrow(/reasoning call to x/);
      expect(elsewhere).toEqual([]);
    } finally {
      provider.server.close();
      target.server.close();
    }
  });

  it("reports why fetch failed, not only that it did", async () => {
    // A port that was just free: nothing listens there, so the connection is refused.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const cfg = {
      models: { providers: { x: { baseUrl: `http://127.0.0.1:${port}/v1`, models: [] } } },
    } as unknown as KoLoConfig;
    await expect(
      createApiReasoner(cfg, { apiKey: key }).reason(req({ model: "x/m" })),
    ).rejects.toThrow(/reasoning call to x failed: fetch failed \(.*ECONNREFUSED/);
    const thrower = (async () => {
      throw "socket hang up";
    }) as unknown as typeof fetch;
    await expect(
      createApiReasoner({}, { fetch: thrower, apiKey: key }).reason(req()),
    ).rejects.toThrow(/failed: socket hang up/);
  });

  it("needs a key except for a local Ollama", async () => {
    const none = async () => null;
    await expect(
      createApiReasoner({}, { fetch: fakeFetch(200, ok("x")), apiKey: none }).reason(req()),
    ).rejects.toThrow(/no API key/);
    const calls: Call[] = [];
    const local = createApiReasoner(
      {},
      {
        fetch: fakeFetch(200, { message: { content: "x" }, done_reason: "stop" }, calls),
        apiKey: none,
      },
    );
    await expect(local.reason(req({ model: "ollama/qwen2.5:7b" }))).resolves.toMatchObject({
      text: "x",
    });
    expect(calls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\/chat$/);
  });

  it("asks a local Ollama for a context that fits the prompt and refuses a prompt that filled it", async () => {
    const none = async () => null;
    const calls: Call[] = [];
    const prompt = "a".repeat(40_000);
    const local = createApiReasoner(
      {},
      {
        fetch: fakeFetch(200, { message: { content: "plan" }, prompt_eval_count: 16_100 }, calls),
        apiKey: none,
      },
    );
    await local.reason(req({ model: "ollama/qwen3:4b", prompt }));
    const sent = JSON.parse(calls[0].init?.body as string) as {
      options: { num_ctx: number };
      tools?: unknown;
    };
    expect(sent.options.num_ctx).toBe(ollamaContextFor(prompt));
    expect(sent.options.num_ctx).toBeGreaterThanOrEqual(20_000);
    expect(sent.tools).toBeUndefined();
    const full = createApiReasoner(
      {},
      {
        fetch: fakeFetch(200, { message: { content: "plan" }, prompt_eval_count: 8192 }),
        apiKey: none,
      },
    );
    await expect(full.reason(req({ model: "ollama/qwen3:4b", prompt: "short" }))).rejects.toThrow(
      /filled the model's context \(8192 tokens\) and was cut/,
    );
    const cut = createApiReasoner(
      {},
      {
        fetch: fakeFetch(200, { message: { content: "par" }, done_reason: "length" }),
        apiKey: none,
      },
    );
    await expect(cut.reason(req({ model: "ollama/qwen3:4b" }))).rejects.toThrow(
      /cut off at the token limit/,
    );
  });

  it("sizes the Ollama context between its bounds", () => {
    expect(ollamaContextFor("")).toBe(OLLAMA_MIN_CONTEXT);
    expect(ollamaContextFor("x".repeat(1_000_000))).toBe(OLLAMA_MAX_CONTEXT);
  });
});

describe("resolveApiEndpoint", () => {
  it("uses a configured provider such as a Qwen endpoint", () => {
    const cfg = {
      models: {
        providers: {
          qwen: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/", models: [] },
        },
      },
    } as unknown as KoLoConfig;
    expect(resolveApiEndpoint(cfg, "qwen/qwen-flash")).toEqual({
      provider: "qwen",
      model: "qwen-flash",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      style: "openai",
    });
  });

  it("refuses bad references, remote plain HTTP and non-chat APIs", () => {
    expect(() => resolveApiEndpoint({}, "gpt-oss-120b")).toThrow(/<provider>\/<model>/);
    expect(() => resolveApiEndpoint({}, "nope/model")).toThrow(/no base URL/);
    const http = {
      models: { providers: { x: { baseUrl: "http://example.com/v1", models: [] } } },
    } as unknown as KoLoConfig;
    expect(() => resolveApiEndpoint(http, "x/m")).toThrow(/https/);
    expect(() => resolveApiEndpoint({}, "anthropic/claude")).toThrow(/anthropic-messages/);
  });

  it("allows plain HTTP to a model on a private network, not to a public host", () => {
    const at = (baseUrl: string) =>
      ({ models: { providers: { x: { baseUrl, models: [] } } } }) as unknown as KoLoConfig;
    for (const ok of [
      "http://model:11434/v1",
      "http://10.0.0.5:11434/v1",
      "http://172.20.0.3/v1",
      "http://192.168.1.9/v1",
      "http://127.0.0.2/v1",
      "http://[fd00::5]/v1",
    ]) {
      expect(resolveApiEndpoint(at(ok), "x/m").baseUrl).toBe(ok);
    }
    for (const bad of [
      "http://model.example.com/v1",
      "http://8.8.8.8/v1",
      "http://172.32.0.1/v1",
      "http://[2001:db8::1]/v1",
      "http://[fc::1]/v1",
      "http://[fd::1]/v1",
      // The URL parser normalizes these to 8.8.8.8, 15.0.0.1 and an IPv4-mapped address.
      "http://8.8.8.8./v1",
      "http://0x08080808/v1",
      "http://017.0.0.1/v1",
      "http://[::ffff:10.0.0.1]/v1",
      "http://10.0.0.1.nip.io/v1",
    ]) {
      expect(() => resolveApiEndpoint(at(bad), "x/m")).toThrow(/https/);
    }
  });

  it("refuses a base URL with credentials without repeating them", async () => {
    // fetch's own error quotes the whole URL, which would put the password in the run reason.
    for (const baseUrl of [
      "http://user:s3cret@model:11434/v1",
      "https://s3cret@api.example.com/v1",
    ]) {
      const cfg = {
        models: { providers: { x: { baseUrl, models: [] } } },
      } as unknown as KoLoConfig;
      const err = await createApiReasoner(cfg, { apiKey: key })
        .reason(req({ model: "x/m" }))
        .catch((e: Error) => e);
      expect(message(err)).toMatch(/must not contain a user name or password/);
      expect(message(err)).not.toContain("s3cret");
    }
  });

  it("refuses a base URL with a query or fragment instead of posting to the wrong path", async () => {
    // Appending /chat/completions after ? or # leaves the request path at the base URL itself.
    for (const baseUrl of [
      "https://api.example.com/v1?key=s3cret",
      "https://api.example.com/v1#frag",
      "https://api.example.com/v1?",
    ]) {
      const fetchFn = vi.fn();
      const cfg = {
        models: { providers: { x: { baseUrl, models: [] } } },
      } as unknown as KoLoConfig;
      const err = await createApiReasoner(cfg, { apiKey: key, fetch: fetchFn })
        .reason(req({ model: "x/m" }))
        .catch((e: Error) => e);
      expect(message(err)).toMatch(/must not contain a query or fragment/);
      expect(message(err)).not.toContain("s3cret");
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });
});

describe("routing reasoner", () => {
  it("sends backend api to the API reasoner and everything else to the CLI one", async () => {
    const tag = (name: string): Reasoner => ({
      reason: async () => ({ text: name, backend: name, model: null }),
    });
    const r = createRoutingReasoner(tag("cli"), tag("api"));
    expect((await r.reason(req({ backend: "api" }))).text).toBe("api");
    expect((await r.reason(req({ backend: "codex-cli" }))).text).toBe("cli");
    expect((await r.reason(req({ backend: null }))).text).toBe("cli");
  });
});
