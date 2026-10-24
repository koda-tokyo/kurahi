import { describe, expect, it, vi } from "vitest";
import { installNativeVoice, nativeVoiceCapture, type NativeVoiceTransport } from "./voice-native";

function fakeNative(chunks: string[]) {
  const queues = new Map<string, { chunks: string[]; stopped: boolean; wake?: () => void }>();
  let next = 0;
  const transport: NativeVoiceTransport = {
    available: vi.fn(async () => true),
    open: vi.fn(async () => {
      const id = `h${++next}`;
      queues.set(id, { chunks: [...chunks], stopped: false });
      return id;
    }),
    read: vi.fn(async (id: string) => {
      const q = queues.get(id);
      if (!q) {
        throw new Error("unknown handle");
      }
      while (!q.chunks.length && !q.stopped) {
        await new Promise<void>((resolve) => (q.wake = resolve));
      }
      return q.chunks.shift() ?? null;
    }),
    stop: vi.fn(async (id: string) => {
      const q = queues.get(id);
      if (q) {
        q.stopped = true;
        q.wake?.();
      }
    }),
    cancel: vi.fn(async (id: string) => {
      const q = queues.get(id);
      if (q) {
        q.chunks = [];
        q.stopped = true;
        q.wake?.();
      }
    }),
  };
  return { transport, queues };
}

describe("native voice capture bridge", () => {
  it("delivers chunks in order and resolves stop only after the last write", async () => {
    const { transport } = fakeNative(["AAA=", "BBB=", "CCC="]);
    const written: string[] = [];
    const capture = nativeVoiceCapture(transport)();
    await capture.start(async (chunk) => {
      await Promise.resolve();
      written.push(chunk);
    }, vi.fn());
    await capture.stop();
    expect(written).toEqual(["AAA=", "BBB=", "CCC="]);
    expect(transport.cancel).not.toHaveBeenCalled();
  });

  it("does not read the next chunk until the previous write resolved", async () => {
    const { transport } = fakeNative(["AAA=", "BBB="]);
    let release!: () => void;
    const capture = nativeVoiceCapture(transport)();
    await capture.start(() => new Promise<void>((resolve) => (release = resolve)), vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.read).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.read).toHaveBeenCalledTimes(2);
    capture.cancel();
  });

  it("releases a handle that opens after cancel during startup", async () => {
    const { transport } = fakeNative([]);
    let open!: (id: string) => void;
    transport.open = vi.fn(() => new Promise<string>((resolve) => (open = resolve)));
    const capture = nativeVoiceCapture(transport)();
    const started = capture.start(vi.fn(), vi.fn());
    capture.cancel();
    open("late");
    await started;
    expect(transport.cancel).toHaveBeenCalledWith("late");
    expect(transport.read).not.toHaveBeenCalled();
  });

  it("gives each start an independent handle so cancelling one leaves the other running", async () => {
    const { transport, queues } = fakeNative([]);
    const factory = nativeVoiceCapture(transport);
    const first = factory();
    const second = factory();
    await first.start(
      vi.fn(async () => {}),
      vi.fn(),
    );
    await second.start(
      vi.fn(async () => {}),
      vi.fn(),
    );
    first.cancel();
    first.cancel();
    expect(transport.cancel).toHaveBeenCalledTimes(1);
    expect(transport.cancel).toHaveBeenCalledWith("h1");
    expect(queues.get("h2")?.stopped).toBe(false);
    second.cancel();
  });

  it("reports native read errors once through failed and releases the handle", async () => {
    const { transport } = fakeNative([]);
    transport.read = vi.fn(async () => {
      throw new Error("device lost");
    });
    const failed = vi.fn();
    const capture = nativeVoiceCapture(transport)();
    await capture.start(vi.fn(), failed);
    await new Promise((r) => setTimeout(r, 0));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(transport.cancel).toHaveBeenCalledWith("h1");
    capture.cancel();
    expect(transport.cancel).toHaveBeenCalledTimes(1);
  });

  it("installs capture only when the native shell reports it available", async () => {
    const host = { voiceCapture: null as ReturnType<typeof nativeVoiceCapture> | null };
    expect(await installNativeVoice(host, null)).toBe(false);
    const { transport } = fakeNative([]);
    transport.available = vi.fn(async () => false);
    expect(await installNativeVoice(host, transport)).toBe(false);
    expect(host.voiceCapture).toBeNull();
    transport.available = vi.fn(async () => {
      throw new Error("no command");
    });
    expect(await installNativeVoice(host, transport)).toBe(false);
    transport.available = vi.fn(async () => true);
    expect(await installNativeVoice(host, transport)).toBe(true);
    expect(host.voiceCapture).toBeTypeOf("function");
  });
});

describe("native bridge with the voice controller", () => {
  it("streams native chunks as ordered voice.audio requests before voice.stop", async () => {
    const { startVoice, stopVoice, emptyVoice } = await import("./voice");
    const { transport } = fakeNative(["AAA=", "BBB="]);
    const calls: Array<[string, unknown]> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "voice.start") {
        return { sessionId: "v1" };
      }
      if (method === "voice.stop") {
        return { sessionId: "v1", text: "ポンプ3の点検", lang: "ja" };
      }
      return {};
    });
    const host = {
      client: { request } as never,
      connected: true,
      voice: emptyVoice(),
      voiceCapture: nativeVoiceCapture(transport),
    };
    await startVoice(host, "plant-demo", "ja");
    await stopVoice(host);
    expect(calls.map(([m]) => m)).toEqual([
      "voice.start",
      "voice.audio",
      "voice.audio",
      "voice.stop",
    ]);
    expect(calls[2][1]).toMatchObject({ sessionId: "v1", chunk: "BBB=", seq: 1 });
    expect(host.voice).toMatchObject({ phase: "ready", text: "ポンプ3の点検" });
  });
});
