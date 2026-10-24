import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth";
import {
  hasExternalSecretStorage,
  installSecretStorage,
  SECRET_STORAGE_KEYS,
  type SecretStorageBackend,
} from "./secret-storage";
import { loadSettings, saveSettings } from "./storage";

function memoryStore(): SecretStorageBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const SETTINGS_KEY = "KoLo.control.settings.v1";
let local: Pick<Storage, "getItem" | "setItem" | "clear" | "length">;

beforeEach(() => {
  if (typeof window === "undefined") {
    const store = memoryStore();
    const browserStore = {
      ...store,
      clear: () => store.map.clear(),
      get length() {
        return store.map.size;
      },
    };
    vi.stubGlobal("localStorage", browserStore);
    vi.stubGlobal("window", { localStorage: browserStore });
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:18789" });
  }
  local = window.localStorage;
  local.clear();
  installSecretStorage(null);
});

afterEach(() => {
  installSecretStorage(null);
  local.clear();
  vi.unstubAllGlobals();
});

describe("secret storage", () => {
  it("browser build: secrets stay in localStorage as before", () => {
    expect(hasExternalSecretStorage()).toBe(false);
    const s = loadSettings();
    saveSettings({ ...s, token: "tok-browser" });
    expect(JSON.parse(local.getItem(SETTINGS_KEY) ?? "{}").token).toBe("tok-browser");
    expect(loadSettings().token).toBe("tok-browser");
  });

  it("host store: the gateway token never lands in localStorage", () => {
    const vault = memoryStore();
    installSecretStorage(vault);
    const s = loadSettings();
    saveSettings({ ...s, gatewayUrl: "ws://127.0.0.1:18850", token: "tok-desktop" });
    const raw = local.getItem(SETTINGS_KEY) ?? "";
    expect(raw).not.toContain("tok-desktop");
    expect(JSON.parse(raw).gatewayUrl).toBe("ws://127.0.0.1:18850");
    expect(vault.map.get(SECRET_STORAGE_KEYS.gatewayToken)).toBe("tok-desktop");
    expect(loadSettings().token).toBe("tok-desktop");
    saveSettings({ ...loadSettings(), token: "" });
    expect(vault.map.has(SECRET_STORAGE_KEYS.gatewayToken)).toBe(false);
  });

  it("host store: a token left in localStorage by an older build is moved out", () => {
    local.setItem(SETTINGS_KEY, JSON.stringify({ gatewayUrl: "ws://127.0.0.1:1", token: "old" }));
    const vault = memoryStore();
    installSecretStorage(vault);
    expect(loadSettings().token).toBe("old");
    expect(local.getItem(SETTINGS_KEY)).not.toContain("old");
    expect(vault.map.get(SECRET_STORAGE_KEYS.gatewayToken)).toBe("old");
  });

  it("host store: device-auth tokens go to the host store", () => {
    const vault = memoryStore();
    installSecretStorage(vault);
    storeDeviceAuthToken({ deviceId: "dev1", role: "operator", token: "dt", scopes: ["b", "a"] });
    expect(local.length).toBe(0);
    expect(loadDeviceAuthToken({ deviceId: "dev1", role: "operator" })?.token).toBe("dt");
    expect(vault.map.has(SECRET_STORAGE_KEYS.deviceAuth)).toBe(true);
  });
});
