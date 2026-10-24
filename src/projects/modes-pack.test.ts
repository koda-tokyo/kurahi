import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Project } from "./types.js";
import { checkToolPermission } from "../agents/permissions.js";
import { loadProjectPack, PACK_SECTIONS, seedStarterPack } from "./pack.js";
import {
  LEGACY_ANALYZER_TOOLS,
  projectContextForAgent,
  projectPermissionSet,
  projectPluginIds,
  writableForMode,
} from "./scope.js";
import { createProject, getProject, projectDataDir, projectMode, setProjectMode } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-modes-test-"));
const home = path.join(tmpRoot, "state");
const prevHome = process.env.KOLO_HOME;
process.env.KOLO_HOME = home;

afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = prevHome;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFolder(name: string): string {
  const dir = path.join(tmpRoot, name);
  for (const sub of ["source", "output", "plans", "notes"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return fs.realpathSync(dir);
}

const rules = {
  readOnly: ["source"],
  writable: ["output", "notes"],
  artifactApprovalRequired: false,
  instructions: [],
};

function check(project: Project, toolName: string, args: Record<string, unknown>) {
  return checkToolPermission({
    toolName,
    args,
    permissionSet: projectPermissionSet(project, home),
    workspaceDir: path.join(tmpRoot, "ws"),
  });
}

describe("project permission modes (参照 / 計画 / 実行)", () => {
  const folder = makeFolder("mode-project");
  const base = createProject({ name: "Modes", folder, rules }, { createdBy: "owner", home });

  it("new projects start in plan mode; old projects without a mode keep act", () => {
    expect(base.mode).toBe("plan");
    expect(projectMode({})).toBe("act");
    expect(projectMode({ mode: "read" })).toBe("read");
  });

  it("参照 read: reads only; writes, commands and outbound tools are refused", () => {
    const p = { ...base, mode: "read" as const };
    expect(check(p, "read", { path: `${folder}/source/a.cbl` }).ok).toBe(true);
    expect(check(p, "write", { path: `${folder}/output/a.md` }).ok).toBe(false);
    expect(check(p, "edit", { path: `${folder}/plans/a.md` }).ok).toBe(false);
    expect(check(p, "exec", { command: "ls" }).ok).toBe(false);
    expect(check(p, "message", { to: "x" }).ok).toBe(false);
    expect(check(p, "sessions_send", {}).ok).toBe(false);
    expect(check(p, "web_fetch", { url: "https://example.com" }).ok).toBe(false);
    expect(check(p, "some_mcp_tool", {}).ok).toBe(false);
    const d = check(p, "write", { path: `${folder}/output/a.md` });
    expect(d.ok ? "" : d.reason).toMatch(/read mode/);
    expect(writableForMode(p)).toEqual([]);
  });

  it("計画 plan: writes only to plans/ and output/, never elsewhere, no commands", () => {
    const p = { ...base, mode: "plan" as const };
    expect(check(p, "write", { path: `${folder}/plans/step1.md` }).ok).toBe(true);
    expect(check(p, "write", { path: `${folder}/output/draft.md` }).ok).toBe(true);
    expect(check(p, "write", { path: `${folder}/notes/n.md` }).ok).toBe(false);
    expect(check(p, "write", { path: `${folder}/source/a.cbl` }).ok).toBe(false);
    expect(check(p, "write", { path: `${folder}/x.md` }).ok).toBe(false);
    expect(check(p, "apply_patch", { patch: `*** Update File: ${folder}/source/a.cbl\n` }).ok).toBe(
      false,
    );
    expect(check(p, "exec", { command: "cat x" }).ok).toBe(false);
    expect(check(p, "process", { action: "start" }).ok).toBe(false);
    expect(check(p, "message", {}).ok).toBe(false);
    expect(writableForMode(p).toSorted()).toEqual(["output", "plans"]);
  });

  it("計画 plan never writes into a read-only plans/ or output/", () => {
    const p = {
      ...base,
      mode: "plan" as const,
      rules: { ...rules, readOnly: ["source", "output"] },
    };
    expect(writableForMode(p)).toEqual(["plans"]);
    expect(check(p, "write", { path: `${folder}/output/draft.md` }).ok).toBe(false);
  });

  it("実行 act: the project's writable folders; commands stay off in projects", () => {
    const p = { ...base, mode: "act" as const };
    expect(check(p, "write", { path: `${folder}/notes/n.md` }).ok).toBe(true);
    expect(check(p, "write", { path: `${folder}/output/o.md` }).ok).toBe(true);
    expect(check(p, "write", { path: `${folder}/plans/p.md` }).ok).toBe(false);
    expect(check(p, "write", { path: `${folder}/source/a.cbl` }).ok).toBe(false);
    expect(check(p, "exec", { command: "ls" }).ok).toBe(false);
    expect(check(p, "message", {}).ok).toBe(true);
  });

  it("changes the mode persistently and reports from/to", () => {
    const r = setProjectMode(base.id, "read", { home });
    expect(r).toMatchObject({ from: "plan", to: "read" });
    expect(getProject(base.id, home)?.mode).toBe("read");
    expect(() => setProjectMode(base.id, "admin", { home })).toThrow(/read, plan or act/);
    expect(projectContextForAgent({ ...base, mode: "read" })).toContain("Mode: read only");
  });
});

describe("engineering pack", () => {
  const folder = makeFolder("pack-project");
  const project = createProject({ name: "Pack", folder, rules }, { createdBy: "owner", home });
  const write = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const data = path.join(projectDataDir(project.id, home), "context");
  const own = path.join(folder, "context");
  write(own, "prompts/p.md", "PROMPT");
  write(own, "rules/b.md", "RULE-B");
  write(own, "rules/a.md", "RULE-A");
  write(data, "rules/0-template.md", "RULE-TEMPLATE");
  write(own, "guides/g.md", "GUIDE");
  write(own, "processes/z.md", "PROCESS");
  write(own, "templates/t.md", "TEMPLATE");
  write(own, "rules/image.png", "binary");
  write(own, "rules/_answer-keys/k.md", "SECRET");
  write(own, "unknown/x.md", "IGNORED");

  it("loads rules first, then processes, guides, templates, prompts; project before template", () => {
    const pack = loadProjectPack(project, { home });
    expect(pack.files.map((f) => f.path)).toEqual([
      "rules/a.md",
      "rules/b.md",
      "rules/0-template.md",
      "processes/z.md",
      "guides/g.md",
      "templates/t.md",
      "prompts/p.md",
    ]);
    expect(pack.files.map((f) => f.source)).toEqual([
      "project",
      "project",
      "template",
      "project",
      "project",
      "project",
      "project",
    ]);
    expect(pack.text.indexOf("RULE-A")).toBeLessThan(pack.text.indexOf("PROCESS"));
    expect(pack.text).not.toContain("SECRET");
    expect(pack.text).not.toContain("IGNORED");
    expect(pack.text.startsWith("[Engineering pack]")).toBe(true);
    expect(PACK_SECTIONS[0]).toBe("rules");
  });

  it("is deterministic", () => {
    expect(loadProjectPack(project, { home }).text).toBe(loadProjectPack(project, { home }).text);
  });

  it("keeps within the budget, truncating the file that crosses it", () => {
    write(own, "rules/c-long.md", "x".repeat(500));
    const pack = loadProjectPack(project, { home, budget: 120 });
    const long = pack.files.find((f) => f.path === "rules/c-long.md");
    expect(long?.truncated).toBe(true);
    expect(long?.includedChars).toBeLessThan(500);
    const later = pack.files.filter((f) => f.section !== "rules");
    expect(later.every((f) => f.includedChars === 0 && f.truncated)).toBe(true);
    expect(pack.text.length).toBeLessThanOrEqual(120 + "[Engineering pack]\n".length + 80);
    expect(pack.text).toContain("[... truncated:");
    expect(pack.totalChars).toBeGreaterThan(pack.includedChars);
    fs.rmSync(path.join(own, "rules/c-long.md"));
  });

  it("returns an empty pack when there is none", () => {
    const empty = createProject(
      { name: "Empty", folder: makeFolder("empty") },
      { createdBy: "owner", home },
    );
    expect(loadProjectPack(empty, { home })).toMatchObject({ files: [], text: "", totalChars: 0 });
  });

  it("seeds a template's starter pack into the data area, not the client folder", () => {
    const fresh = createProject(
      { name: "Seed", folder: makeFolder("seed") },
      { createdBy: "owner", home },
    );
    const n = seedStarterPack(
      fresh.id,
      path.join(resolveTemplatesDir({}), "packs", "industry-legacy-modernisation"),
      home,
    );
    expect(n).toBeGreaterThanOrEqual(5);
    expect(fs.existsSync(path.join(fresh.folder, "context"))).toBe(false);
    const pack = loadProjectPack(fresh, { home });
    expect(pack.files[0].path).toBe("rules/01-source-is-read-only.md");
    expect(pack.text).toContain("file:line");
    for (const id of ["research-academic", "professional", "education"]) {
      expect(fs.existsSync(path.join(resolveTemplatesDir({}), "packs", id, "rules"))).toBe(true);
    }
  });
});

describe("legacy analyser in projects (参照 / 計画 / 実行)", () => {
  const folder = makeFolder("legacy-analyser-project");
  fs.mkdirSync(path.join(folder, "source", "cobol", "_answer-keys"), { recursive: true });
  const tpl = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "industry-legacy-modernisation",
  )!;
  const project = createProject(
    { name: "Legacy", folder },
    { createdBy: "owner", template: tpl, home },
  );

  it("the legacy template enables the analyser for its projects only", () => {
    expect(tpl.plugins).toEqual(["legacy-analyzer"]);
    expect(project.plugins).toEqual(["legacy-analyzer"]);
    expect(projectPluginIds(project)).toEqual(["legacy-analyzer"]);
    // A project made before projects carried plugins falls back to its template's list.
    const { plugins: _drop, ...old } = project;
    expect(projectPluginIds(old, [tpl])).toEqual(["legacy-analyzer"]);
    // Other templates enable nothing; a client cannot add plugins through the API input.
    const plain = createProject(
      { name: "Plain", folder: makeFolder("plain-project"), plugins: ["legacy-analyzer"] } as never,
      { createdBy: "owner", home },
    );
    expect(plain.plugins).toEqual([]);
  });

  it.each(["read", "plan", "act"] as const)(
    "%s mode: the analyser tools are reads of the project folder, never of _answer-keys",
    (mode) => {
      const p = { ...project, mode };
      for (const tool of LEGACY_ANALYZER_TOOLS) {
        expect(check(p, tool, { path: folder }).ok, `${tool} ${mode}`).toBe(true);
        expect(check(p, tool, { path: `${folder}/source/cobol` }).ok).toBe(true);
        expect(check(p, tool, { path: `${folder}/source/cobol/_answer-keys` }).ok).toBe(false);
        expect(check(p, tool, { path: tmpRoot }).ok).toBe(false);
      }
      expect(check(p, "exec", { command: "cobc -x PAYCALC.cbl" }).ok).toBe(false);
    },
  );

  it("the agent is told to use the analyser first and cite file:line", () => {
    const ctx = projectContextForAgent(project);
    expect(ctx).toContain(`legacy_index with path "${folder}"`);
    expect(ctx).toMatch(/cite each one as file:line/);
    const n = seedStarterPack(
      project.id,
      path.join(resolveTemplatesDir({}), "packs", "industry-legacy-modernisation"),
      home,
    );
    expect(n).toBeGreaterThanOrEqual(6);
    const pack = loadProjectPack(project, { home });
    expect(pack.files.map((f) => f.path)).toContain("rules/02-analyser-first.md");
    expect(pack.files.map((f) => f.path)).toContain("rules/03-capability-truth.md");
    expect(pack.files.map((f) => f.path)).toContain("processes/02-modernisation-lifecycle.md");
    expect(pack.files.map((f) => f.path)).toContain("guides/02-domain-playbooks.md");
    expect(pack.files.map((f) => f.path)).toContain("templates/02-modernisation-assessment.md");
    expect(pack.text).toMatch(/legacy_index.*first/i);
    expect(pack.text).toMatch(/deterministic built-in analyser currently covers COBOL/i);
    expect(pack.text).toMatch(/covers COBOL.*Java, SQL DDL, FORTRAN and PL\/I/i);
    expect(pack.text).toMatch(/FORTRAN.*PL\/I/i);
    expect(pack.files.every((f) => !f.truncated)).toBe(true);
    // Routing: each language goes to the engine that owns it; planned assistants are named as such.
    expect(pack.text).toMatch(
      /SQL DDL, FORTRAN or PL\/I: `modernise_plan` on the project folder first/,
    );
    expect(pack.text).toMatch(/then `modernise_inventory`, `modernise_crud`.*`modernise_impact`/);
    expect(pack.text).toMatch(/COBOL, copybooks and JCL: `legacy_index` first/);
    expect(pack.text).toMatch(/planned has no engine: say so/);
    // Rule 03 defers to rule 02's routing; rule 02 item 5 carves out engine-less reading.
    expect(pack.text).not.toMatch(/\(start with `modernise_plan`\)/);
    expect(pack.text).toMatch(/evidence; rules\/02 routes the first tool by language/);
    expect(pack.text).toMatch(
      /or, with no engine \(item 2\), to cite it `file:line`, never `verified`/,
    );
    expect(pack.text).toMatch(/\*\*Java\/SQL DDL:\*\* `modernise_plan`/);
    expect(tpl.starterPrompts.some((s) => /legacy_index.*legacy_rules/.test(s.en ?? ""))).toBe(
      true,
    );
  });

  it("defines one truthful industrial modernization role across the requested domains", () => {
    expect(tpl.name.en).toBe("Industrial: system modernisation");
    expect(
      tpl.rules.instructions.some((r) => /Industrial Modernization Engineer/.test(r.en ?? "")),
    ).toBe(true);
    expect(tpl.description.en).toMatch(/COBOL\/JCL.*FORTRAN.*PL\/I.*Java/);
    expect(tpl.description.en).toMatch(/databases.*PLC code.*batch scheduling/i);
    expect(tpl.description.en).toMatch(/maintenance.*cybersecurity/i);
    // The template's own words agree with the pack (rules/03) and with the engines
    // `modernise_plan` reports as active: FORTRAN and PL/I are analysed too.
    expect(tpl.description.en).toMatch(
      /currently supports COBOL, copybooks and JCL, Java, SQL DDL, FORTRAN and PL\/I/,
    );
    expect(tpl.description.ja).toMatch(/JCL、Java、SQL DDL、FORTRAN、PL\/I に対応/);
    const routing = tpl.rules.instructions.find((r) => /legacy_index first/.test(r.en ?? ""));
    expect(routing?.en).toMatch(/Java, SQL DDL, FORTRAN, PL\/I.*start with modernise_plan/);
    expect(routing?.ja).toMatch(/FORTRAN、PL\/I.*まず modernise_plan/);
    expect(routing?.en).not.toMatch(/For every other domain/);
    expect(tpl.starterPrompts.some((p) => /PLC code.*cyber risk/i.test(p.en ?? ""))).toBe(true);
  });
});
