import { describe, expect, test, vi } from "vitest";
import { lazyModule } from "./lazy-module.js";

describe("lazyModule", () => {
  test("imports on first call only and forwards arguments and results", async () => {
    const add = vi.fn(async (a: number, b: number) => a + b);
    const importer = vi.fn(async () => ({ add, sync: () => 1 }));
    const mod = lazyModule(importer);
    const lazyAdd = mod.fn("add");
    expect(importer).not.toHaveBeenCalled();
    await expect(lazyAdd(1, 2)).resolves.toBe(3);
    await expect(lazyAdd(3, 4)).resolves.toBe(7);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(3, 4);
  });

  test("propagates errors and retries a failed import", async () => {
    let fail = true;
    const importer = vi.fn(async () => {
      if (fail) {
        throw new Error("missing dependency");
      }
      return { run: async () => "ok" };
    });
    const run = lazyModule(importer).fn("run");
    await expect(run()).rejects.toThrow("missing dependency");
    fail = false;
    await expect(run()).resolves.toBe("ok");
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
