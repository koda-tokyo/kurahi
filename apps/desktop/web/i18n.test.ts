import { describe, expect, it } from "vitest";
import { LOCALES, matchLocale, missingMessages, resolveLocale, t } from "./i18n";

describe("first-run locale", () => {
  it("follows the OS locale", () => {
    expect(matchLocale(["ja-JP", "en-US"])).toBe("ja");
    expect(matchLocale(["en-GB"])).toBe("en");
    expect(matchLocale(["pt-BR", "fr"])).toBe("en");
    expect(matchLocale(["fr-FR", "ja"])).toBe("ja");
    expect(matchLocale([])).toBe("en");
  });

  it("a saved choice wins over the OS", () => {
    expect(resolveLocale("en", ["ja-JP"])).toBe("en");
    expect(resolveLocale("ja", ["en-US"])).toBe("ja");
    expect(resolveLocale("xx", ["ja-JP"])).toBe("ja");
    expect(resolveLocale(null, ["en-US"])).toBe("en");
  });

  it("ships complete ja and en catalogues", () => {
    expect(LOCALES.map((l) => l.id)).toEqual(["ja", "en"]);
    expect(missingMessages("ja")).toEqual([]);
    expect(t("ja", "action.open")).toBe("Kurahi を開く");
    expect(t("en", "action.open")).toBe("Open Kurahi");
  });

  it("uses the exact maker name and no vendor names", () => {
    for (const l of LOCALES) {
      expect(t(l.id, "app.by")).toContain("KODA SōKEN");
    }
    const text = LOCALES.flatMap((l) =>
      ["app.tagline", "app.by", "step.engine", "action.open"].map((id) => t(l.id, id as never)),
    ).join(" ");
    expect(text).not.toMatch(/claude|anthropic|openai|gpt|gemini/i);
  });
});
