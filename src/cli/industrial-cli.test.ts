import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject } from "../projects/store.js";
import {
  runIndustrialImport,
  runIndustrialImports,
  runIndustrialProviders,
} from "./industrial-cli.js";
import { getSubCliEntries } from "./program/register.subclis.js";

const FIXTURES = path.join(
  import.meta.dirname,
  "..",
  "industrial",
  "vendor-import",
  "test-fixtures",
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-industrial-cli-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
let projectId = "";

const importDeps = {
  config: {
    scanner: "auto" as const,
    requireScan: true,
    scanTimeoutMs: 2000,
    extractTimeoutMs: 1000,
    extractMaxOldSpaceMb: 64,
  },
  scanner: {
    name: "clamav" as const,
    scan: async () => ({
      verdict: "clean" as const,
      scanner: "clamav" as const,
      signature: null,
      detail: null,
      ms: 1,
    }),
  },
};

function fakeRuntime() {
  const out: string[] = [];
  const errors: string[] = [];
  const runtime: RuntimeEnv = {
    log: (...a: unknown[]) => void out.push(a.join(" ")),
    error: (...a: unknown[]) => void errors.push(a.join(" ")),
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  };
  return { runtime, out, errors };
}

beforeAll(() => {
  const folder = path.join(root, "client");
  fs.mkdirSync(folder, { recursive: true });
  projectId = createProject(
    { name: "CLI", folder, allowedAgents: [], rules: { readOnly: [], writable: [] }, mode: "act" },
    { createdBy: "device:admin" },
  ).id;
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
  fs.rmSync(root, { recursive: true, force: true });
});

describe("kurahi industrial", () => {
  it("is registered as a sub-CLI", () => {
    expect(getSubCliEntries().map((e) => e.name)).toContain("industrial");
  });

  it("providers: remote modes are reported as disabled, formats with their verification (AC-044)", () => {
    const { runtime, out } = fakeRuntime();
    runIndustrialProviders({}, { runtime });
    const text = out.join("\n");
    expect(text).toMatch(/aws-transform-remote {2}REMOTE_API {2}DISABLED/);
    expect(text).toMatch(/google-mat-remote {2}REMOTE_MCP {2}DISABLED/);
    expect(text).toMatch(/Planned, not active/);
    expect(text).toMatch(/neo4j-jsonl {2}VERIFIED_FROM_DOCS/);
    expect(text).toMatch(/business-rules-export {2}UNVERIFIED_SCHEMA/);
    const json = fakeRuntime();
    runIndustrialProviders({ json: true }, { runtime: json.runtime });
    expect(JSON.parse(json.out[0]).providers.length).toBeGreaterThan(5);
  });

  it("import: imports a fixture, reports a duplicate, refuses with exit 1", async () => {
    const ok = fakeRuntime();
    await runIndustrialImport(
      { project: projectId, provider: "ibm-z", bundle: path.join(FIXTURES, "ibm-z-docgen") },
      { runtime: ok.runtime, importDeps },
    );
    expect(ok.out[0]).toMatch(
      /^Imported imp-[a-f0-9]{20}: ibm-z understand-docgen-md \(VERIFIED_FROM_DOCS\)\./,
    );
    const again = fakeRuntime();
    await runIndustrialImport(
      {
        project: projectId,
        provider: "ibm-z",
        bundle: path.join(FIXTURES, "ibm-z-docgen"),
        json: true,
      },
      { runtime: again.runtime, importDeps },
    );
    expect(JSON.parse(again.out.join("\n"))).toMatchObject({
      status: "duplicate",
      format: "understand-docgen-md",
    });
    const bad = fakeRuntime();
    await expect(
      runIndustrialImport(
        { project: projectId, provider: "google-mat", bundle: path.join(FIXTURES, "ibm-z-docgen") },
        { runtime: bad.runtime, importDeps },
      ),
    ).rejects.toThrow("exit 1");
    expect(bad.errors[0]).toMatch(/^Refused at manifest: SCHEMA_REJECTED\./);
    const list = fakeRuntime();
    runIndustrialImports({ project: projectId }, { runtime: list.runtime });
    expect(list.out).toHaveLength(1);
  });

  it("import: usage errors exit 2", async () => {
    for (const opts of [
      {},
      { project: projectId, provider: "ibm-z" },
      { project: projectId, provider: "ibm-z-remote", bundle: "x" },
      { project: "p-missing", provider: "ibm-z", bundle: "x" },
    ]) {
      const { runtime, errors } = fakeRuntime();
      await expect(runIndustrialImport(opts, { runtime, importDeps })).rejects.toThrow("exit 2");
      expect(errors[0]).toMatch(/^kurahi industrial: /);
    }
  });
});
