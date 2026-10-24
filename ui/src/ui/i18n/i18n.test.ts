import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import {
  getLocale,
  LOCALES,
  matchLocale,
  missingMessages,
  resolveLocale,
  setLocale,
  t,
} from "./index";
import { ja } from "./ja";

afterEach(() => setLocale("en"));

describe("locale catalogue", () => {
  it("ships ja and en, complete", () => {
    expect(LOCALES.map((l) => l.id)).toEqual(["ja", "en"]);
    expect(missingMessages("ja")).toEqual([]);
    expect(missingMessages("en")).toEqual([]);
  });

  it("ja has no keys that en lacks", () => {
    for (const key of Object.keys(ja)) {
      expect(key in en, key).toBe(true);
    }
  });

  it("resolves user choice, then organisation default, then OS, then English", () => {
    expect(resolveLocale({ user: "en", org: "ja", os: ["ja-JP"] })).toBe("en");
    expect(resolveLocale({ user: null, org: "ja", os: ["en-US"] })).toBe("ja");
    expect(resolveLocale({ user: null, org: null, os: ["ja-JP", "en"] })).toBe("ja");
    expect(resolveLocale({ user: null, org: "fr", os: ["pt-BR"] })).toBe("en");
    expect(resolveLocale({})).toBe("en");
    expect(resolveLocale({ user: "xx", org: null, os: ["ja"] })).toBe("ja");
  });

  it("matches region and underscore variants", () => {
    expect(matchLocale(["ja_JP"])).toBe("ja");
    expect(matchLocale(["EN-gb"])).toBe("en");
    expect(matchLocale(["zh-Hans", "ko"])).toBeNull();
  });

  it("translates with fallback and parameters", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
    expect(t("header.status.running")).toBe("稼働中");
    expect(t("header.status.stopped")).toBe("停止");
    expect(t("header.status.attention")).toBe("要確認");
    expect(t("home.approvals.some", { count: 3 })).toBe("3 件");
    setLocale("en");
    expect(t("audit.count", { shown: 2, total: 5 })).toBe("2 of 5 records");
    setLocale("fr");
    expect(getLocale()).toBe("en");
  });

  it("uses singular forms for a count of one", () => {
    setLocale("en");
    expect(t("home.agents.count", { count: 1 })).toBe("1 agent");
    expect(t("home.agents.count", { count: 2 })).toBe("2 agents");
    expect(t("home.agents.count", { count: 0 })).toBe("0 agents");
    expect(t("connectors.tools", { count: 1 })).toBe("1 tool");
    setLocale("ja");
    expect(t("home.agents.count", { count: 1 })).toBe("エージェント 1 件");
  });

  it("uses the exact connector status words", () => {
    expect(ja["connectors.status.active"]).toBe("稼働中");
    expect(ja["connectors.status.unverified"]).toBe("未検証");
    expect(ja["connectors.status.disabled"]).toBe("無効");
    expect(ja["connectors.status.planned"]).toBe("計画中");
  });

  it("names no AI vendor or model in the UI text", () => {
    const all = [...Object.values(en), ...Object.values(ja)].join("\n");
    expect(all).not.toMatch(/claude|anthropic|openai|chatgpt|\bgpt|gemini|llama|qwen|mistral/i);
    expect(all).toContain("KODA SōKEN");
  });
});
