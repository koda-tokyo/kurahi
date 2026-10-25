// The plugin's change-detection and Word tools as an agent (or the autopilot) calls them, in a
// real Project: legacy_changes / legacy_baseline_advance, and legacy_design_doc output_format docx.
import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginToolContext } from "../../src/plugins/types.js";
import type { ProjectMode } from "../../src/projects/types.js";
import { A, B, program } from "../../packages/legacy-analyzer/src/test-fixtures/helpers.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import { designDocStem, ymd } from "./design-doc-docx.js";
import register from "./index.js";

type Result = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<Result> };

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-legacy-tools-")));
const home = path.join(tmpRoot, "state");
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  process.env.KOLO_HOME = home;
  process.env.KOLO_STATE_DIR = home;
});
afterAll(() => {
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const CALC = program("ORDCALC", {
  proc: [A("0000-MAIN."), B("PERFORM 1000-PRICE"), B("STOP RUN."), A("1000-PRICE."), B("GOBACK.")],
});

let seq = 0;
function setup(mode: ProjectMode = "act", session = true) {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  fs.mkdirSync(path.join(folder, "source", "cobol"), { recursive: true });
  fs.mkdirSync(path.join(folder, "output"), { recursive: true });
  fs.writeFileSync(path.join(folder, "source", "cobol", "ORDCALC.cbl"), `${CALC}\n`);
  const project = createProject(
    {
      name: `Legacy ${seq}`,
      folder,
      mode,
      rules: {
        readOnly: ["source"],
        writable: ["output"],
        artifactApprovalRequired: false,
        instructions: [],
      },
    },
    { createdBy: "owner", home },
  );
  let factory: ((ctx: KoLoPluginToolContext) => unknown) | null = null;
  register({
    paths: { stateDir: home },
    registerTool: (f: (ctx: KoLoPluginToolContext) => unknown) => {
      factory = f;
    },
  } as unknown as KoLoPluginApi);
  const tools = factory!({
    workspaceDir: project.folder,
    ...(session ? { sessionKey: projectSessionKey("main", project.id, "c1") } : {}),
  }) as Tool[];
  const call = (name: string, params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("t1", params);
  return { folder: project.folder, call };
}

describe("legacy_changes and legacy_baseline_advance (plugin tools)", () => {
  it("reports noInput on the first run and on no change, then the change, then advances", async () => {
    const { folder, call } = setup();
    const first = await call("legacy_changes", { path: "source", since: "baseline" });
    expect(first.details).toMatchObject({ ok: true, status: "baseline_created", noInput: true });
    expect(JSON.parse(first.content[0].text)).toMatchObject({ path: "source" });
    expect((await call("legacy_changes", { path: "source" })).details).toMatchObject({
      status: "unchanged",
      noInput: true,
      noInputReason: "no change since the baseline",
    });
    fs.writeFileSync(
      path.join(folder, "source", "cobol", "ORDNEW.cbl"),
      `${program("ORDNEW", { proc: [A("0000-MAIN."), B("GOBACK.")] })}\n`,
    );
    const changed = await call("legacy_changes", { path: "source" });
    expect(changed.details).toMatchObject({ status: "changed", noInput: false });
    const snapshot = changed.details?.snapshot as string;
    const adv = await call("legacy_baseline_advance", { path: "source", snapshot });
    expect(JSON.parse(adv.content[0].text)).toMatchObject({ status: "advanced" });
    expect((await call("legacy_changes", { path: "source" })).details?.status).toBe("unchanged");
    // Nothing was written into the sources.
    expect(fs.readdirSync(path.join(folder, "source", "cobol")).toSorted()).toEqual([
      "ORDCALC.cbl",
      "ORDNEW.cbl",
    ]);
  });

  it("refuses an unknown since and a malformed snapshot", async () => {
    const { call } = setup();
    expect(
      (await call("legacy_changes", { path: "source", since: "yesterday" })).details,
    ).toMatchObject({
      ok: false,
    });
    expect(
      (await call("legacy_baseline_advance", { path: "source", snapshot: "../x" })).details,
    ).toMatchObject({ ok: false });
  });
});

describe("legacy_design_doc output_format docx", () => {
  it("writes 設計書_<date>.docx into output/design-docs/, never over an existing file", async () => {
    const { folder, call } = setup();
    const stem = designDocStem("ja", new Date());
    expect(stem).toBe(`設計書_${ymd(new Date())}`);
    const one = await call("legacy_design_doc", { path: "source", output_format: "docx" });
    expect(one.details).toMatchObject({ ok: true, output_format: "docx" });
    expect(one.details?.path).toBe(`output/design-docs/${stem}.docx`);
    expect(one.content[0].text).toContain(`Word document: output/design-docs/${stem}.docx`);
    const two = await call("legacy_design_doc", { path: "source", format: "docx" });
    expect(two.details?.path).toBe(`output/design-docs/${stem}-2.docx`);

    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(folder, String(one.details?.path))),
    );
    for (const part of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
    ]) {
      expect(zip.file(part)).not.toBeNull();
    }
    const xml = await zip.file("word/document.xml")!.async("string");
    // Japanese preserved: title, a heading, and a table header from the Markdown.
    expect(xml).toContain("設計書（ソースコードから生成）");
    expect(xml).toContain("システム概要");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("ORDCALC");
    expect(xml).toContain('w:val="Code"');
    expect(await zip.file("word/styles.xml")!.async("string")).toContain('w:val="ja-JP"');
  });

  it("names the English document design-doc_<date>.docx", async () => {
    const { call } = setup();
    const res = await call("legacy_design_doc", {
      path: "source",
      lang: "en",
      output_format: "docx",
    });
    expect(res.details?.path).toBe(`output/design-docs/design-doc_${ymd(new Date())}.docx`);
  });

  it("keeps Markdown the default and refuses Word outside a Project or in Read mode", async () => {
    const md = await setup().call("legacy_design_doc", { path: "source" });
    expect(md.details).toMatchObject({ ok: true });
    expect(md.details?.path).toBeUndefined();
    const outside = await setup("act", false).call("legacy_design_doc", {
      path: "source",
      output_format: "docx",
    });
    expect(outside.details).toMatchObject({ ok: false });
    expect(outside.content[0].text).toMatch(/Project chat/);
    const readOnly = setup("read");
    const refused = await readOnly.call("legacy_design_doc", {
      path: "source",
      output_format: "docx",
    });
    expect(refused.details).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(readOnly.folder, "output", "design-docs"))).toBe(false);
    const bad = await setup().call("legacy_design_doc", { path: "source", output_format: "pdf" });
    expect(bad.details).toMatchObject({ ok: false });
  });
});
