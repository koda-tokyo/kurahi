// modernise_import as an agent calls it in a real Project, and the imported data as
// modernise_inventory (kind imported) and modernise_impact return it.
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectMode } from "../../src/projects/types.js";
import { flushAudit } from "../../src/audit/audit-log.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import { importTools } from "./import-tools.js";
import { moderniseTools } from "./modernise-tools.js";

type Result = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<Result> };

const FIXTURES = path.join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "industrial",
  "vendor-import",
  "test-fixtures",
);
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-import-tools-")));
const home = path.join(tmpRoot, "state");
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  process.env.KOLO_HOME = home;
  process.env.KOLO_STATE_DIR = home;
});
afterAll(async () => {
  await flushAudit();
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

let seq = 0;
function setup(mode: ProjectMode = "act", session = true) {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  fs.mkdirSync(path.join(folder, "source"), { recursive: true });
  fs.mkdirSync(path.join(folder, "output"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "google-mat-neo4j"), path.join(folder, "imports", "mat"), {
    recursive: true,
  });
  const project = createProject(
    {
      name: `Imports ${seq}`,
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
  const sessionKey = () => (session ? projectSessionKey("main", project.id, "c1") : undefined);
  const scanner = {
    name: "clamav" as const,
    scan: async () => ({
      verdict: "clean" as const,
      scanner: "clamav" as const,
      signature: null,
      detail: null,
      ms: 1,
    }),
  };
  const pathParam = Type.String();
  const tools = [
    ...importTools({
      pathParam,
      sessionKey,
      agentId: () => "main",
      importDeps: {
        scanner,
        config: {
          scanner: "auto",
          requireScan: true,
          scanTimeoutMs: 2000,
          extractTimeoutMs: 1000,
          extractMaxOldSpaceMb: 64,
        },
      },
    }),
    ...moderniseTools({
      root: (p) => path.resolve(folder, String(p.path)),
      pathParam,
      env: { stateDir: home },
      sessionKey,
    }),
  ] as unknown as Tool[];
  const call = async (name: string, params: Record<string, unknown>) => {
    const r = await tools.find((t) => t.name === name)!.execute("t1", params);
    return { ...r, json: () => JSON.parse(r.content[0].text) };
  };
  return { folder, call };
}

describe("modernise_import (plugin tool)", () => {
  it("imports a bundle in the Project, then is idempotent", async () => {
    const { call } = setup();
    const r = await call("modernise_import", { path: "imports/mat", provider: "google-mat" });
    expect(r.json()).toMatchObject({
      status: "imported",
      provider: "google-mat",
      format: "neo4j-jsonl",
      verification: "VERIFIED_FROM_DOCS",
      counts: { items: 6, edges: 4, findings: 1 },
    });
    expect(
      (await call("modernise_import", { path: "imports/mat", provider: "google-mat" })).json()
        .status,
    ).toBe("duplicate");
    const list = (await call("modernise_import", { action: "list" })).json();
    expect(list.imports).toHaveLength(1);
  });

  it("lists the provider registry with remote modes disabled", async () => {
    const { call } = setup("read", false);
    const r = (await call("modernise_import", { action: "providers" })).json();
    const remote = r.providers.filter((p: { access_mode: string }) =>
      p.access_mode.startsWith("REMOTE"),
    );
    expect(remote.length).toBe(4);
    expect(remote.every((p: { status: string }) => p.status === "DISABLED")).toBe(true);
  });

  it("refuses outside a Project, in Read mode, and a bundle outside the Project folder", async () => {
    expect(
      (await setup("act", false).call("modernise_import", { action: "list" })).details,
    ).toMatchObject({
      ok: false,
    });
    const ro = setup("read");
    const r = await ro.call("modernise_import", { path: "imports/mat", provider: "google-mat" });
    expect(r.content[0].text).toMatch(/Read mode/);
    const { call } = setup();
    expect(
      (
        await call("modernise_import", {
          path: path.join(FIXTURES, "google-mat-neo4j"),
          provider: "google-mat",
        })
      ).content[0].text,
    ).toMatch(/inside the Project folder/);
    expect(
      (await call("modernise_import", { path: "../", provider: "google-mat" })).content[0].text,
    ).toMatch(/inside the Project folder/);
  });

  it("returns a refusal with its reason and evidence for a tampered bundle", async () => {
    const { folder, call } = setup();
    fs.appendFileSync(path.join(folder, "imports", "mat", "graph", "assessment.jsonl"), "\n");
    const r = (
      await call("modernise_import", { path: "imports/mat", provider: "google-mat" })
    ).json();
    expect(r).toMatchObject({ status: "refused", code: "ARTEFACT_INTEGRITY_FAILED" });
    expect(r.evidence.root).toMatch(/^[a-f0-9]{64}$/);
  });

  it("shows imports to modernise_inventory and modernise_impact, separately and labelled", async () => {
    const { call } = setup();
    await call("modernise_import", { path: "imports/mat", provider: "google-mat" });
    const inv = (await call("modernise_inventory", { path: "source", kind: "imported" })).json();
    expect(inv.note).toMatch(/unverified/);
    expect(inv.imports[0].items.map((i: { name: string }) => i.name)).toContain("PAYCALC");
    const impact = (await call("modernise_impact", { path: "source", target: "TAXCALC" })).json();
    const edges = impact.imported.imports[0].upstream;
    expect(
      edges.map((e: { fromName: string; relation: string }) => `${e.fromName} ${e.relation}`),
    ).toEqual(["PAYCALC CALLS"]);
    expect(edges[0]).toMatchObject({
      provenance: "IMPORTED_VENDOR_ARTEFACT",
      confidence: "UNVERIFIED",
    });
    // Outside a Project nothing imported is mixed in.
    const plain = setup("act", false);
    const noProject = (
      await plain.call("modernise_impact", { path: "source", target: "TAXCALC" })
    ).json();
    expect(noProject.imported).toBeUndefined();
  });
});
