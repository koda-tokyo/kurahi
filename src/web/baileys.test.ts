import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginBaileysEntry, WhatsAppRuntimeMissingError } from "./baileys.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("WhatsApp library is optional", () => {
  it("is not a production dependency of the runtime package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      files?: string[];
    };
    expect(pkg.dependencies?.["@whiskeysockets/baileys"]).toBeUndefined();
    expect(pkg.optionalDependencies?.["@whiskeysockets/baileys"]).toBeUndefined();
    expect(pkg.files).toContain("!extensions/whatsapp/**");
    const plugin = JSON.parse(
      fs.readFileSync(path.join(ROOT, "extensions", "whatsapp", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(plugin.dependencies?.["@whiskeysockets/baileys"]).toBeTruthy();
  });

  it("only src/web/baileys.ts loads it; everything else uses type imports", () => {
    const offenders = listSources(path.join(ROOT, "src"))
      .filter((file) => !file.endsWith(path.join("web", "baileys.ts")))
      .filter((file) => !file.includes("test-helpers") && !file.includes("test-utils"))
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return /^\s*import\s+(?!type\b)[^;]*?from\s+"@whiskeysockets\/baileys"/m.test(text);
      })
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("finds the library inside an installed plugin folder", () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-baileys-"));
    try {
      expect(pluginBaileysEntry(ext)).toBeNull();
      const pkgDir = path.join(ext, "whatsapp", "node_modules", "@whiskeysockets", "baileys");
      fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), '{"main":"lib/index.js"}');
      expect(pluginBaileysEntry(ext)).toBeNull();
      fs.writeFileSync(path.join(pkgDir, "lib", "index.js"), "export {};\n");
      expect(pluginBaileysEntry(ext)).toBe(path.join(pkgDir, "lib", "index.js"));
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  it("has no top-level await (plugin sources load through a CommonJS transform)", () => {
    const text = fs.readFileSync(path.join(ROOT, "src", "web", "baileys.ts"), "utf8");
    expect(text).not.toMatch(/^(?:const|let|export const)[^\n]*=\s*await\b/m);
    expect(text).not.toMatch(/^await\b/m);
  });

  it("names the separate install in the missing-library error", () => {
    expect(new WhatsAppRuntimeMissingError().message).toMatch(/kurahi plugins install/);
    expect(new WhatsAppRuntimeMissingError().message).toMatch(/GPL-3\.0/);
  });
});
