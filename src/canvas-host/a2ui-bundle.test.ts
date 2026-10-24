// The A2UI bundle is loaded by a browser page as a plain ES module, so it must be self-contained:
// a bare import left in it (an alias the bundler did not match) fails at load time in the page,
// while the build only prints "Module not found, treating it as an external dependency".
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUNDLE = path.join(ROOT, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const BOOTSTRAP = path.join(
  ROOT,
  "apps",
  "shared",
  "KoLoKit",
  "Tools",
  "CanvasA2UI",
  "bootstrap.js",
);
const ROLLDOWN = path.join(path.dirname(BOOTSTRAP), "rolldown.config.mjs");

// Real bundles start with a license banner or code; the stub tests write is one line.
const isRealBundle = (text: string) => text.length > 10_000;

describe("A2UI canvas bundle", () => {
  it("every bare import in the bootstrap has a bundler alias (exact case)", () => {
    if (!fs.existsSync(BOOTSTRAP) || !fs.existsSync(ROLLDOWN)) {
      return; // Docker builds exclude apps/
    }
    const bootstrap = fs.readFileSync(BOOTSTRAP, "utf8");
    const config = fs.readFileSync(ROLLDOWN, "utf8");
    const bare = [...bootstrap.matchAll(/^\s*import[^;]*?from\s+"([^".][^"]*)"/gm)].map(
      (m) => m[1] as string,
    );
    expect(bare.length).toBeGreaterThan(0);
    const missing = bare.filter((spec) => {
      const root = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      return (
        !config.includes(`"${spec}"`) &&
        !config.includes(`"${root}/"`) &&
        !config.includes(`${root}:`) &&
        !config.includes(`"${root}"`)
      );
    });
    expect(missing).toEqual([]);
  });

  it("the built bundle has no bare imports left", () => {
    if (!fs.existsSync(BUNDLE)) {
      return; // not built in this checkout
    }
    const text = fs.readFileSync(BUNDLE, "utf8");
    if (!isRealBundle(text)) {
      return;
    }
    const bare = [...text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"'./][^"']*)["']/gm)].map(
      (m) => m[1],
    );
    expect(bare).toEqual([]);
  });
});
