import { describe, expect, test } from "vitest";
import { resolveDrainTimeoutMs } from "./server-close.js";

describe("resolveDrainTimeoutMs", () => {
  test("defaults to 30 s and accepts a non-negative integer override", () => {
    expect(resolveDrainTimeoutMs({})).toBe(30_000);
    expect(resolveDrainTimeoutMs({ KOLO_GATEWAY_DRAIN_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(resolveDrainTimeoutMs({ KOLO_GATEWAY_DRAIN_TIMEOUT_MS: "0" })).toBe(0);
    expect(resolveDrainTimeoutMs({ KOLO_GATEWAY_DRAIN_TIMEOUT_MS: "-5" })).toBe(30_000);
    expect(resolveDrainTimeoutMs({ KOLO_GATEWAY_DRAIN_TIMEOUT_MS: "soon" })).toBe(30_000);
  });
});
