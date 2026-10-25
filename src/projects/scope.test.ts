import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveProjectFile } from "./scope.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-scope-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveProjectFile with a symlinked project folder", () => {
  // macOS: /var and /tmp are symlinks, so a project folder is often configured through one.
  const real = path.join(tmp, "real");
  const link = path.join(tmp, "link");
  fs.mkdirSync(path.join(real, "docs"), { recursive: true });
  fs.writeFileSync(path.join(real, "docs", "a.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(tmp, "outside.txt"), "x");
  fs.symlinkSync(real, link, "dir");

  it("accepts an absolute path under either spelling of the folder", () => {
    const expected = fs.realpathSync(path.join(real, "docs", "a.pdf"));
    expect(resolveProjectFile(link, path.join(link, "docs", "a.pdf"))).toBe(expected);
    expect(resolveProjectFile(link, path.join(real, "docs", "a.pdf"))).toBe(expected);
    expect(resolveProjectFile(link, "docs/a.pdf")).toBe(expected);
  });

  it("accepts the symlinked spelling when the folder is stored resolved (macOS /var → /private/var)", () => {
    const expected = fs.realpathSync(path.join(real, "docs", "a.pdf"));
    expect(resolveProjectFile(real, path.join(link, "docs", "a.pdf"))).toBe(expected);
  });

  it("still refuses paths outside the folder and symlink escapes", () => {
    expect(() => resolveProjectFile(link, path.join(tmp, "outside.txt"))).toThrow(/outside/);
    expect(() => resolveProjectFile(link, "../outside.txt")).toThrow(/outside/);
    fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(real, "docs", "escape.txt"));
    expect(() => resolveProjectFile(link, "docs/escape.txt")).toThrow(/symbolic link/);
  });
});
