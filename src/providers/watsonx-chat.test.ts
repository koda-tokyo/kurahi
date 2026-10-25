import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createIbmIamTokenCache } from "./ibm-iam.js";
import {
  buildWatsonxBody,
  createWatsonxStream,
  parseWatsonxEndpoint,
  readSseData,
  watsonxRequestUrl,
} from "./watsonx-chat.js";

// Recorded-shape fixtures: the SSE frames of POST /ml/v1/text/chat_stream as the watsonx.ai Node
// SDK types describe them (`event: message`, `data: TextChatStreamResponse`, choices[].delta).
// Values are fake; nothing here came from a live account.

const BASE = "https://jp-tok.ml.cloud.ibm.com?project_id=0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";

const model = (baseUrl = BASE): Model<Api> =>
  ({
    id: "ibm/granite-3-8b-instruct",
    name: "granite",
    api: "watsonx-chat",
    provider: "watsonx",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }) as Model<Api>;

const context: Context = {
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

const frame = (id: number, data: unknown) =>
  `id: ${id}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`;

const textFrames = [
  frame(1, {
    id: "chat-1",
    model_id: "ibm/granite-3-8b-instruct",
    created: 1,
    choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: "Kon" } }],
  }),
  frame(2, {
    id: "chat-1",
    model_id: "ibm/granite-3-8b-instruct",
    created: 1,
    choices: [{ index: 0, finish_reason: null, delta: { content: "nichiwa" } }],
  }),
  frame(3, {
    id: "chat-1",
    model_id: "ibm/granite-3-8b-instruct",
    created: 1,
    choices: [{ index: 0, finish_reason: "stop", delta: { content: "" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }),
];

const toolFrames = [
  frame(1, {
    id: "chat-2",
    model_id: "ibm/granite-3-8b-instruct",
    created: 1,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "chatcmpl-tool-1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":' },
            },
          ],
        },
      },
    ],
  }),
  frame(2, {
    id: "chat-2",
    model_id: "ibm/granite-3-8b-instruct",
    created: 1,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        delta: { tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] },
      },
    ],
  }),
];

function sseResponse(frames: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) {
          // Split frames across chunks to exercise the reader.
          c.enqueue(enc.encode(f.slice(0, 7)));
          c.enqueue(enc.encode(f.slice(7)));
        }
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function harness(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (u.startsWith("https://iam.cloud.ibm.com/")) {
      return new Response(JSON.stringify({ access_token: "iam-token", expires_in: 3600 }), {
        status: 200,
      });
    }
    calls.push({ url: u, init: init ?? {} });
    return response();
  });
  const tokens = createIbmIamTokenCache({ fetchFn: fetchFn as unknown as typeof fetch });
  const stream = createWatsonxStream({ fetchFn: fetchFn as unknown as typeof fetch, tokens });
  return { stream, calls, fetchFn };
}

describe("watsonx endpoint settings", () => {
  it("defaults to Tokyo, the 2024-03-14 version and the chat paths", () => {
    const ep = parseWatsonxEndpoint(BASE);
    expect(ep).toMatchObject({
      origin: "https://jp-tok.ml.cloud.ibm.com",
      version: "2024-03-14",
      mode: "chat",
      auth: "iam",
      projectId: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab",
    });
    expect(watsonxRequestUrl(ep, true)).toBe(
      "https://jp-tok.ml.cloud.ibm.com/ml/v1/text/chat_stream?version=2024-03-14",
    );
    expect(watsonxRequestUrl(ep, false)).toBe(
      "https://jp-tok.ml.cloud.ibm.com/ml/v1/text/chat?version=2024-03-14",
    );
  });

  it("supports a space, another region and version, and the model gateway", () => {
    const ep = parseWatsonxEndpoint(
      "https://us-south.ml.cloud.ibm.com?space_id=abc-123&version=2025-02-11",
    );
    expect(ep).toMatchObject({ spaceId: "abc-123", version: "2025-02-11" });
    const gw = parseWatsonxEndpoint("https://cpd.example.com?mode=gateway&auth=bearer");
    expect(watsonxRequestUrl(gw, true)).toBe(
      "https://cpd.example.com/ml/gateway/v1/chat/completions",
    );
    expect(gw.auth).toBe("bearer");
  });

  it("refuses unusable settings", () => {
    expect(() => parseWatsonxEndpoint("https://jp-tok.ml.cloud.ibm.com")).toThrow(/project_id/);
    expect(() => parseWatsonxEndpoint("http://jp-tok.ml.cloud.ibm.com?project_id=a")).toThrow(
      /https/,
    );
    expect(() => parseWatsonxEndpoint(`${BASE}&space_id=b`)).toThrow(/not both/);
    expect(() => parseWatsonxEndpoint(`${BASE}&version=latest`)).toThrow(/YYYY-MM-DD/);
    expect(() => parseWatsonxEndpoint(`${BASE}&iam_url=http://iam.example.com/t`)).toThrow(/https/);
    expect(() => parseWatsonxEndpoint("https://x.example.com?project_id=a%20b")).toThrow(/id/);
  });
});

describe("watsonx request body", () => {
  it("uses model_id and project_id for text/chat, OpenAI fields for the gateway", () => {
    const tools = [
      { name: "get_weather", description: "Weather", parameters: { type: "object" } },
    ] as unknown as Context["tools"];
    const chat = buildWatsonxBody(model(), { ...context, tools }, parseWatsonxEndpoint(BASE), {
      maxTokens: 100,
    });
    expect(chat).toMatchObject({
      model_id: "ibm/granite-3-8b-instruct",
      project_id: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab",
      max_tokens: 100,
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });
    expect(chat).not.toHaveProperty("model");
    expect(chat).not.toHaveProperty("tool_choice_option");
    expect((chat.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "system",
      "user",
    ]);
    const gw = buildWatsonxBody(
      model(),
      context,
      parseWatsonxEndpoint("https://g.example.com?mode=gateway"),
      {},
    );
    expect(gw).toMatchObject({ model: "ibm/granite-3-8b-instruct", stream: true });
    expect(gw).not.toHaveProperty("project_id");
  });
});

describe("watsonx streaming", () => {
  it("exchanges the key, streams text, and records usage", async () => {
    const h = harness(() => sseResponse(textFrames));
    const s = h.stream(model(), context, { apiKey: "ibm-cloud-key" });
    const types: string[] = [];
    for await (const ev of s) {
      types.push(ev.type);
    }
    const msg = await s.result();
    expect(msg.stopReason).toBe("stop");
    expect(msg.content).toEqual([{ type: "text", text: "Konnichiwa" }]);
    expect(msg.usage).toMatchObject({ input: 12, output: 3, totalTokens: 15 });
    expect(types[0]).toBe("start");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    const call = h.calls[0];
    expect(call.url).toBe(
      "https://jp-tok.ml.cloud.ibm.com/ml/v1/text/chat_stream?version=2024-03-14",
    );
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer iam-token");
    expect(JSON.parse(call.init.body as string)).toMatchObject({
      model_id: "ibm/granite-3-8b-instruct",
    });
  });

  it("assembles streamed tool calls", async () => {
    const h = harness(() => sseResponse(toolFrames));
    const msg = await h.stream(model(), context, { apiKey: "k" }).result();
    expect(msg.stopReason).toBe("toolUse");
    expect(msg.content).toEqual([
      {
        type: "toolCall",
        id: "chatcmpl-tool-1",
        name: "get_weather",
        arguments: { city: "Tokyo" },
      },
    ]);
  });

  it("sends the stored token as-is with auth=bearer", async () => {
    const h = harness(() => sseResponse(textFrames));
    await h.stream(model(`${BASE}&auth=bearer`), context, { apiKey: "zen-token" }).result();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect((h.calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer zen-token",
    );
  });

  it("turns an IBM error answer into an error event without the key", async () => {
    const h = harness(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ code: "model_not_supported", message: "Model is not supported" }],
            trace: "t-1",
            status_code: 404,
          }),
          { status: 404 },
        ),
    );
    const msg = await h.stream(model(), context, { apiKey: "ibm-cloud-key" }).result();
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toBe(
      "watsonx.ai request failed: HTTP 404 (model_not_supported: Model is not supported)",
    );
    expect(msg.errorMessage).not.toContain("ibm-cloud-key");
  });

  it("fails cleanly with no key", async () => {
    const h = harness(() => sseResponse(textFrames));
    const prev = process.env.WATSONX_AI_APIKEY;
    delete process.env.WATSONX_AI_APIKEY;
    try {
      const msg = await h.stream(model(), context, {}).result();
      expect(msg.errorMessage).toMatch(/No API key/);
    } finally {
      if (prev !== undefined) {
        process.env.WATSONX_AI_APIKEY = prev;
      }
    }
  });
});

describe("SSE reader", () => {
  it("handles CRLF, named events, [DONE] and a final frame without a blank line", async () => {
    const body = new Response(
      'event: message\r\ndata: {"a":1}\r\n\r\ndata: [DONE]\n\ndata: {"b":2}',
    ).body as ReadableStream<Uint8Array>;
    const out: string[] = [];
    for await (const d of readSseData(body)) {
      out.push(d);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
