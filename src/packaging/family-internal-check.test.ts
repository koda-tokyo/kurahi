import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTargets,
  runCheck,
  scanPath,
  scanSource,
  sourcePathOf,
} from "../../scripts/family-internal-check.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Built at runtime so this file itself never contains the identifiers it tests.
const BODY_FILE = ["hormones", "json"].join(".");
const BODY_WORD = ["proprio", "ception"].join("");
const PRIVATE_TOOL = ["kolo", "biology", "status"].join("_");
const BODY_RUNTIME = ["Biology", "BootSupervisor"].join("");
const BODY_GAUGE = ["biology", "hormones"].join("_");

let root: string;

function write(rel: string, text: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-family-check-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("family-internal-check", () => {
  it("passes the real product tree", () => {
    const { findings } = runCheck(REPO_ROOT);
    expect(findings).toEqual([]);
  });

  it("flags body-state files, private tool names and the removed module", () => {
    const hits = scanSource(
      [
        "const ok = 1;",
        `const p = path.join(dir, "${BODY_FILE}");`,
        `server.tool("${PRIVATE_TOOL}", "x");`,
        `const s = state.${BODY_WORD};`,
        'import x from "./kolo-server.js";',
      ].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.id])).toEqual([
      [2, "body-state-file"],
      [3, "private-mcp-tool"],
      [4, "body-state"],
      [5, "private-mcp-module"],
    ]);
  });

  it("flags the removed gateway biology layer", () => {
    const hits = scanSource(
      [
        `const s = new ${BODY_RUNTIME}();`,
        `registry.addMetric("${BODY_GAUGE}", "x", "gauge", []);`,
        "// biology is an ordinary word and stays allowed",
      ].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.id])).toEqual([
      [1, "body-state-runtime"],
      [2, "body-state-runtime"],
    ]);
    expect(scanPath(["dist", "gateway-v3", "biology", "index.js"].join("/"))).toEqual([
      "body-state-runtime",
    ]);
  });

  it("does not block the product's sibling feature", () => {
    const hits = scanSource(
      'await client.request("sibling.send", { to: siblingId });\nconst s = cfg.siblings;\n',
    );
    expect(hits).toEqual([]);
  });

  it("fails a tree that would ship the private MCP server, even before a build", () => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/mcp/kolo-server.ts", "export {};\n");
    write("src/x.test.ts", `const t = "${BODY_FILE}";\n`);
    const targets = collectTargets(root);
    expect(targets.distBuilt).toBe(false);
    expect(targets.sources).not.toContain("src/x.test.ts");
    const { findings } = runCheck(root);
    expect(findings).toContain("dist/mcp/kolo-server.js: private-mcp-module: file would ship");
  });

  it("scans built dist text, ignoring tests", () => {
    write("src/a.ts", "export const a = 1;\n");
    write("dist/a.js", `export const a = "${BODY_FILE}";\n`);
    write("dist/a.test.js", `export const b = "${BODY_FILE}";\n`);
    const { findings, distBuilt } = runCheck(root);
    expect(distBuilt).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^dist\/a\.js:1: body-state-file:/);
  });

  it("honours allow rules with reasons, mapped from src to dist", () => {
    write("src/a.ts", `export const a = "${BODY_FILE}";\n`);
    write("dist/a.js", `export const a = "${BODY_FILE}";\n`);
    write(
      ".family-internal-allow",
      `# comment\nsrc/a.ts | ${BODY_FILE} | tracked for removal in the next release\n`,
    );
    expect(runCheck(root).findings).toEqual([]);
    expect(sourcePathOf("dist/a/b.d.ts")).toBe("src/a/b.ts");
  });

  it("rejects allow rules without a reason", () => {
    write("src/a.ts", "export {};\n");
    write(".family-internal-allow", "src/a.ts | * | \n");
    expect(() => runCheck(root)).toThrow(/bad \.family-internal-allow line/);
  });

  it("flags shipped paths named after body state", () => {
    expect(scanPath(`dist/x/${BODY_WORD}.js`)).toEqual(["body-state"]);
    expect(scanPath("dist/mcp/client/tools.js")).toEqual([]);
  });
});
