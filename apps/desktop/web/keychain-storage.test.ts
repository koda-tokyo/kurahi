import { describe, expect, it, vi } from "vitest";
import { SECRET_STORAGE_KEYS } from "../../../ui/src/ui/secret-storage";
import { createKeychainStorage } from "./keychain-storage";

function fakeApi(initial: Record<string, string> = {}, persistent = true) {
  const vault = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    vault,
    calls,
    api: {
      secretGetAll: vi.fn(async () => ({ persistent, values: Object.fromEntries(vault) })),
      secretSet: vi.fn(async (k: string, v: string) => {
        calls.push(`set:${k}`);
        vault.set(k, v);
      }),
      secretDelete: vi.fn(async (k: string) => {
        calls.push(`del:${k}`);
        vault.delete(k);
      }),
    },
  };
}

describe("keychain storage", () => {
  it("preloads values and writes through in order", async () => {
    const f = fakeApi({ [SECRET_STORAGE_KEYS.gatewayToken]: "t1" });
    const s = await createKeychainStorage(f.api);
    expect(s.persistent).toBe(true);
    expect(s.backend.getItem(SECRET_STORAGE_KEYS.gatewayToken)).toBe("t1");
    s.backend.setItem(SECRET_STORAGE_KEYS.gatewayToken, "t2");
    s.backend.removeItem(SECRET_STORAGE_KEYS.gatewayToken);
    s.backend.setItem(SECRET_STORAGE_KEYS.deviceAuth, "{}");
    expect(s.backend.getItem(SECRET_STORAGE_KEYS.gatewayToken)).toBeNull();
    await s.flush();
    expect(f.calls).toEqual([
      `set:${SECRET_STORAGE_KEYS.gatewayToken}`,
      `del:${SECRET_STORAGE_KEYS.gatewayToken}`,
      `set:${SECRET_STORAGE_KEYS.deviceAuth}`,
    ]);
    expect(f.vault.has(SECRET_STORAGE_KEYS.gatewayToken)).toBe(false);
  });

  it("skips no-op writes", async () => {
    const f = fakeApi({ [SECRET_STORAGE_KEYS.gatewayToken]: "same" });
    const s = await createKeychainStorage(f.api);
    s.backend.setItem(SECRET_STORAGE_KEYS.gatewayToken, "same");
    s.backend.removeItem(SECRET_STORAGE_KEYS.pairCredential);
    await s.flush();
    expect(f.calls).toEqual([]);
  });

  it("moves secrets out of localStorage", async () => {
    const legacy = new Map([
      [SECRET_STORAGE_KEYS.deviceIdentity, "{\"version\":1}"],
      ["KoLo.control.settings.v1", "{}"],
    ]);
    const ls = { getItem: (k: string) => legacy.get(k) ?? null, removeItem: (k: string) => void legacy.delete(k) };
    const f = fakeApi();
    const s = await createKeychainStorage(f.api, ls);
    await s.flush();
    expect(legacy.has(SECRET_STORAGE_KEYS.deviceIdentity)).toBe(false);
    expect(legacy.has("KoLo.control.settings.v1")).toBe(true);
    expect(f.vault.get(SECRET_STORAGE_KEYS.deviceIdentity)).toBe("{\"version\":1}");
  });

  it("reports a keychain write failure and keeps going", async () => {
    const f = fakeApi({}, false);
    f.api.secretSet.mockRejectedValueOnce(new Error("locked"));
    const errors: unknown[] = [];
    const s = await createKeychainStorage(f.api, undefined, (e) => errors.push(e));
    expect(s.persistent).toBe(false);
    s.backend.setItem(SECRET_STORAGE_KEYS.gatewayToken, "a");
    s.backend.setItem(SECRET_STORAGE_KEYS.deviceAuth, "b");
    await s.flush();
    expect(errors).toHaveLength(1);
    expect(f.vault.get(SECRET_STORAGE_KEYS.deviceAuth)).toBe("b");
  });
});
