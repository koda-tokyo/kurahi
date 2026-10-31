// modernise_verify as an agent calls it in a real Project: confined to the workspace, writing
// snapshots and evidence only under the Project's data area, never into the sources.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginToolContext } from "../../src/plugins/types.js";
import { verifyEvidenceBundle } from "../../src/evidence/verify.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject, projectDataDir } from "../../src/projects/store.js";
import register from "./index.js";

type Result = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<Result> };

const FX = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../test/fixtures/modernisation",
);
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-verify-tool-")));
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

function setup() {
  const folder = path.join(tmpRoot, "project");
  fs.cpSync(path.join(FX, "pli-payroll"), path.join(folder, "pli"), { recursive: true });
  const project = createProject(
    {
      name: "Verify",
      folder,
      mode: "act",
      rules: {
        readOnly: ["pli"],
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
    workspaceDir: folder,
    sessionKey: projectSessionKey("main", project.id, "c1"),
  }) as Tool[];
  const call = (params: Record<string, unknown>) =>
    tools.find((t) => t.name === "modernise_verify")!.execute("t1", params);
  return { folder, project, call };
}

describe("modernise_verify (plugin tool)", () => {
  it("reports PL/I as NOT_RUN_COMPILER_UNAVAILABLE with evidence in the Project's data area", async () => {
    const { folder, project, call } = setup();
    const before = fs
      .readdirSync(path.join(folder, "pli"), { recursive: true })
      .map(String)
      .toSorted((a, b) => a.localeCompare(b));
    const res = await call({
      baseline: "pli/baseline",
      candidate: "pli/candidate",
      fixtures: "pli/fixtures",
    });
    expect(res.details).toMatchObject({ ok: true, verdict: "NOT_RUN_COMPILER_UNAVAILABLE" });
    expect(res.content[0].text).toMatch(/no PL\/I compiler is available/);
    const bundle = res.details?.bundle as string;
    expect(
      bundle.startsWith(path.join(projectDataDir(project.id, home), "modernisation", "runs")),
    ).toBe(true);
    expect((await verifyEvidenceBundle(bundle)).ok).toBe(true);
    expect(
      fs
        .readdirSync(path.join(folder, "pli"), { recursive: true })
        .map(String)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(before);
  });

  it("refuses paths outside the workspace and bad parameters", async () => {
    const { call } = setup();
    expect(
      (await call({ baseline: "../../etc", candidate: "pli/candidate" })).details,
    ).toMatchObject({ ok: false });
    expect((await call({ baseline: "pli/baseline" })).details?.error).toMatch(
      /candidate is required/,
    );
    expect(
      (await call({ baseline: "pli/baseline", candidate: "pli/candidate", timeout_seconds: 0 }))
        .details?.error,
    ).toMatch(/timeout_seconds/);
    expect(
      (await call({ baseline: "pli/baseline", candidate: "pli/candidate", dialect: "x; rm" }))
        .details?.error,
    ).toMatch(/dialect/);
  });
});
