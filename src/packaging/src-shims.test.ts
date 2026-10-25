import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDefaultExport, writeSrcShims } from "../../scripts/src-shims.mjs";

describe("hasDefaultExport", () => {
  it.each([
    ["export default function f() {}", true],
    ["export default class {}", true],
    ["const x = 1;\nexport default x;", true],
    ["const x = 1;\nexport { x as default };", true],
    ['export { default } from "./y.js";', true],
    ['export { default as y } from "./y.js";', false],
    ['export * as default from "./y.js";', true],
    ['export * as y from "./y.js";', false],
    ['export * from "./y.js";', false],
    ["export const a = 1;\nexport function b() {}", false],
    ['console.warn("using the first entry as default.");\nexport const a = 1;', false],
    ["// export default is documented here\nexport const a = 1;", false],
    ["const s = `\nexport default 1;\n`;\nexport { s };", false],
  ])("%j → %s", (code, expected) => {
    expect(hasDefaultExport(code)).toBe(expected);
  });
});

describe("writeSrcShims", () => {
  let lib: string;

  function write(rel: string, text: string) {
    const abs = path.join(lib, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }

  beforeEach(() => {
    lib = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-src-shims-"));
  });

  afterEach(() => {
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it("re-exports default only when the built module has one", () => {
    write(
      "extensions/demo/index.ts",
      'import { a } from "../../src/agents/scope.js";\nimport d from "../../src/agents/named.js";\n',
    );
    write(
      "dist/agents/scope.js",
      'console.warn("using the first entry as default.");\nexport const a = 1;\n',
    );
    write("dist/agents/named.js", "export default 1;\n");

    expect(writeSrcShims(lib, ["demo"])).toEqual({ written: 2, missing: [] });
    const scope = fs.readFileSync(path.join(lib, "src/agents/scope.js"), "utf8");
    const named = fs.readFileSync(path.join(lib, "src/agents/named.js"), "utf8");
    expect(scope).toContain('export * from "../../dist/agents/scope.js";');
    expect(scope).not.toContain("default");
    expect(named).toContain('export { default } from "../../dist/agents/named.js";');
  });

  it("ignores test-support directories, which import the repository test harness", () => {
    write("extensions/demo/index.ts", "export const a = 1;\n");
    write("extensions/demo/test/setup.ts", 'import "../../../test/setup.js";\n');

    expect(writeSrcShims(lib, ["demo"])).toEqual({ written: 0, missing: [] });
  });
});
