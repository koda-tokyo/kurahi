import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLegacyMcp } from "./server.js";
import { connect, demoProject, wideCopybook, type Connected } from "./test-project.js";
import { LEGACY_TOOLS } from "./tools.js";

const AT = /^source\/(cobol|copybook|jcl)\/[A-Z]+\.(cbl|cpy|jcl):\d+$/;

function treeOutsideKurahi(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".kurahi") {
          visit(full);
        }
      } else {
        out.push(`${path.relative(root, full)}:${fs.lstatSync(full).mtimeMs}`);
      }
    }
  };
  visit(root);
  return out.toSorted();
}

describe("kurahi-legacy MCP server", () => {
  let root: string;
  let before: string[];
  let s: Connected;

  beforeAll(async () => {
    root = demoProject();
    before = treeOutsideKurahi(root);
    s = await connect({ root });
  });
  afterAll(async () => {
    await s.close();
  });

  it("lists the read-only tools with the common arguments", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(LEGACY_TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual([
      "legacy_index_status",
      "legacy_index_build",
      "legacy_query",
      "legacy_rules",
      "legacy_dictionary",
      "legacy_impact",
      "legacy_design_doc",
      "legacy_wave_plan",
      "modernise_plan",
      "modernise_crud",
      "modernise_impact",
      "modernise_inventory",
    ]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["path", "offset", "limit"]),
      );
    }
  });

  it("reports index status, builds the index and reports it fresh", async () => {
    const first = await s.call("legacy_index_status");
    expect(first.isError).toBe(false);
    expect(first.structured.result).toMatchObject({ indexed: false, scope: "." });
    const built = await s.call("legacy_index_build");
    expect(built.structured.result.counts.programs).toBe(3);
    expect(built.structured.result.root).toBeUndefined();
    expect(built.text).toMatch(/Indexed 5 source files under \. .*3 programs, 1 copybooks, 1 jobs/);
    const programs = built.structured.result.programs as Array<{ name: string; at: string }>;
    expect(programs.map((p) => p.name).toSorted()).toEqual(["ORDCALC", "ORDRPT", "ORDTAX"]);
    expect(programs.every((p) => AT.test(p.at))).toBe(true);
    const status = await s.call("legacy_index_status");
    expect(status.structured.result).toMatchObject({ indexed: true, source: "memory", files: 5 });
  });

  it("answers queries with path:line on every fact", async () => {
    const who = await s.call("legacy_query", { kind: "callers", args: { name: "ORDTAX" } });
    const calledBy = who.structured.result.calledBy as Array<{ program: string; at: string }>;
    expect(calledBy.map((c) => c.program)).toEqual(["ORDCALC"]);
    expect(calledBy[0].at).toMatch(/^source\/cobol\/ORDCALC\.cbl:\d+$/);
    const steps = await s.call("legacy_query", { kind: "job-steps", args: { program: "ORDRPT" } });
    expect(steps.structured.result).toMatchObject([
      { job: "ORDJOB", step: "S2", at: "source/jcl/ORDJOB.jcl:4" },
    ]);
    const bad = await s.call("legacy_query", { kind: "callers", args: {} });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/needs the argument "name"/);
  });

  it("lists rule candidates as exact text at path:line", async () => {
    const r = await s.call("legacy_rules", { program: "ORDCALC" });
    const cands = r.structured.result.candidates as Array<{ kind: string; at: string }>;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => /^source\/cobol\/ORDCALC\.cbl:\d+$/.test(c.at))).toBe(true);
    expect(cands.map((c) => c.kind)).toEqual(expect.arrayContaining(["condition", "rounding"]));
    expect(r.text).toMatch(/rule candidates in ORDCALC/);
  });

  it("returns a copybook dictionary with positions", async () => {
    const r = await s.call("legacy_dictionary", { copybook: "ORDREC" });
    const entries = r.structured.result.entries as Array<{ name: string; at: string }>;
    const qty = entries.find((e) => e.name === "ORD-QTY");
    expect(qty?.at).toMatch(/^source\/copybook\/ORDREC\.cpy:\d+$/);
    const all = await s.call("legacy_dictionary");
    expect(all.structured.result.copybooks).toHaveLength(1);
  });

  it("traces the impact of a data item", async () => {
    const r = await s.call("legacy_impact", { item: "ORD-QTY", program: "ORDCALC" });
    expect(r.structured.result.found).toBe(true);
    expect(r.structured.result.programs).toEqual(expect.arrayContaining(["ORDCALC", "ORDRPT"]));
    expect(r.text).toMatch(/^Impact of ORD-QTY/);
  });

  it("scopes a tool to a sub-folder and keeps paths project-relative", async () => {
    const r = await s.call("legacy_rules", { path: "source/cobol", program: "ORDCALC" });
    expect(r.structured.scope).toBe("source/cobol");
    const cands = r.structured.result.candidates as Array<{ at: string }>;
    expect(cands[0].at).toMatch(/^source\/cobol\/ORDCALC\.cbl:\d+$/);
  });

  it("refuses paths that escape the root: ../, absolute, symlink, excluded folders", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mcp-outside-"));
    fs.copyFileSync(path.join(root, "source/cobol/ORDTAX.cbl"), path.join(outside, "X.cbl"));
    fs.symlinkSync(outside, path.join(root, "source", "linked"));
    fs.symlinkSync(path.join(outside, "X.cbl"), path.join(root, "source", "cobol", "LINK.cbl"));
    const cases: Array<[string, RegExp]> = [
      ["../", /outside the project root/],
      ["source/../../", /outside the project root/],
      [outside, /outside the project root/],
      ["/etc", /outside the project root/],
      ["source/linked", /symbolic link/],
      ["source/cobol/LINK.cbl", /symbolic link/],
      ["_answer-keys", /excluded/],
      [".kurahi/legacy-mcp", /excluded/],
      ["no/such/dir", /does not exist/],
    ];
    for (const [p, msg] of cases) {
      const r = await s.call("legacy_index_build", { path: p });
      expect(r.isError, p).toBe(true);
      expect(r.text, p).toMatch(/^Refused: /);
      expect(r.text, p).toMatch(msg);
    }
    // The indexer does not follow links either: the linked program is not in the root index.
    const all = await s.call("legacy_index_build");
    expect(all.structured.result.counts.programs).toBe(3);
    fs.unlinkSync(path.join(root, "source", "linked"));
    fs.unlinkSync(path.join(root, "source", "cobol", "LINK.cbl"));
  });

  it("writes one audit line per call without the arguments", async () => {
    const auditFile = path.join(root, ".kurahi", "legacy-mcp", "audit.jsonl");
    const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const e of entries) {
      expect(e).toMatchObject({ tool: expect.any(String), ok: expect.any(Boolean) });
      expect(e.argsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.resultBytes).toBe("number");
      expect(typeof e.durationMs).toBe("number");
    }
    expect(entries.some((e) => e.error === "path-refused")).toBe(true);
    const raw = fs.readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("ORD-QTY");
    expect(raw).not.toContain("answer-keys");
  });

  it("writes nothing outside the project's .kurahi folder", () => {
    expect(treeOutsideKurahi(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "output", ".legacy-index"))).toBe(false);
    const cache = fs.readdirSync(path.join(root, ".kurahi", "legacy-mcp", "cache"));
    expect(cache.every((f) => /^index-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
  });
});

describe("cache, size cap and pagination", () => {
  it("serves the persisted index after a restart and rebuilds when a source changes", async () => {
    const root = demoProject();
    const a = await connect({ root });
    await a.call("legacy_index_build");
    await a.close();
    const b = await connect({ root });
    expect((await b.call("legacy_index_status")).structured.result.source).toBe("disk");
    fs.writeFileSync(path.join(root, "source", "copybook", "NEW.cpy"), wideCopybook(3));
    expect((await b.call("legacy_index_status")).structured.result.indexed).toBe(false);
    expect((await b.call("legacy_dictionary")).structured.result.copybooks).toHaveLength(2);
    await b.close();
  });

  it("keeps a response under the byte cap and pages through a large list", async () => {
    const root = demoProject({ "source/copybook/WIDE.cpy": wideCopybook(400) });
    const s = await connect({ root, maxBytes: 8192 });
    const first = await s.call("legacy_dictionary", { copybook: "WIDE", limit: 1000 });
    expect(first.isError).toBe(false);
    expect(first.structured.page.total).toBe(401);
    expect(first.structured.reduced?.reason).toMatch(/page reduced/);
    expect(first.bytes).toBeLessThanOrEqual(8192);
    const n = first.structured.result.entries.length as number;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(401);
    expect(first.structured.page.nextOffset).toBe(n);
    expect(first.text).toMatch(new RegExp(`Entries 1-${n} of 401 \\(next offset ${n}\\)`));
    const second = await s.call("legacy_dictionary", { copybook: "WIDE", offset: n, limit: n });
    expect(second.structured.result.entries[0].name).not.toBe(
      first.structured.result.entries[0].name,
    );
    const last = await s.call("legacy_dictionary", { copybook: "WIDE", offset: 400, limit: 5 });
    expect(last.structured.page.nextOffset).toBeNull();
    expect(last.structured.result.entries).toHaveLength(1);
    await s.close();
  });

  it("rejects bad pagination arguments before running", async () => {
    const s = await connect({ root: demoProject() });
    const r = await s.client.callTool({ name: "legacy_rules", arguments: { limit: 5000 } });
    expect(r.isError).toBe(true);
    await s.close();
  });
});

describe("startup checks", () => {
  it("refuses a missing root, a file root and a symlinked .kurahi folder", () => {
    expect(() => openLegacyMcp({ root: "" })).toThrow(/--root is required/);
    expect(() => openLegacyMcp({ root: "/no/such/kurahi/root" })).toThrow(/not found/);
    const root = demoProject();
    expect(() => openLegacyMcp({ root: path.join(root, "source/cobol/ORDTAX.cbl") })).toThrow(
      /not a folder/,
    );
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mcp-elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(root, ".kurahi"));
    expect(() => openLegacyMcp({ root })).toThrow(/not a plain folder/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a symlinked audit file", () => {
    const root = demoProject();
    const ctx = openLegacyMcp({ root });
    const target = path.join(os.tmpdir(), `legacy-mcp-target-${process.pid}.txt`);
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, ctx.state.auditFile);
    expect(() => ctx.state.appendAudit({ x: 1 })).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });
});
