import { describe, expect, it, vi } from "vitest";

describe("removed gateway.v3 flag", () => {
  it("still accepts gateway.v3.biology so existing configs load, without a legacy error", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: { v3: { enabled: true, biology: true, health: true } },
    });
    expect(res.ok).toBe(true);
  });
});
