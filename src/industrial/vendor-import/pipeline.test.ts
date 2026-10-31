import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../../projects/types.js";
import type { AttachmentSecurityConfig } from "../../security/attachment-intake.js";
import type { FileScanner, ScanVerdict } from "../../security/scanner.js";
import { flushAudit } from "../../audit/audit-log.js";
import { verifyEvidenceBundle } from "../../evidence/verify.js";
import { createProject, projectDataDir } from "../../projects/store.js";
import { sha256Hex } from "./manifest.js";
import { importVendorBundle, type ImportStage, type VendorImportDeps } from "./pipeline.js";
import { importsRoot, listImports } from "./store.js";
import { importedImpact, importedInventory } from "./view.js";

const FIXTURES = path.join(import.meta.dirname, "test-fixtures");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-vimport-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

let project: Project;
const CFG: AttachmentSecurityConfig = {
  scanner: "auto",
  requireScan: true,
  scanTimeoutMs: 2000,
  extractTimeoutMs: 10_000,
  extractMaxOldSpaceMb: 128,
};

function scanner(verdict: ScanVerdict["verdict"], seen: string[] = []): FileScanner {
  return {
    name: "clamav",
    async scan(file) {
      seen.push(file);
      return {
        verdict,
        scanner: "clamav",
        signature: verdict === "infected" ? "Eicar-Test-Signature" : null,
        detail: verdict === "error" ? "clamav exit 2" : null,
        ms: 1,
      };
    },
  };
}

const deps = (extra: Partial<VendorImportDeps> = {}): VendorImportDeps => ({
  config: CFG,
  scanner: scanner("clean"),
  ...extra,
});

const run = (provider: string, bundle: string, extra: Partial<VendorImportDeps> = {}) =>
  importVendorBundle({ projectId: project.id, provider, bundle, actor: "main" }, deps(extra));

/** Copy a fixture folder so a test can change it. */
function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(root, `${name}-`));
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

async function zipFolder(dir: string, rename?: (p: string) => string): Promise<string> {
  const zip = new JSZip();
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(abs, e.name), r);
      } else {
        zip.file(rename ? rename(r) : r, fs.readFileSync(path.join(abs, e.name)));
      }
    }
  };
  walk(dir, "");
  const out = path.join(root, `${path.basename(dir)}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return out;
}

/** Rewrite a fixture's manifest after changing its files (a re-export, not a tamper). */
function reManifest(dir: string) {
  const mpath = path.join(dir, "kurahi-import.json");
  const m = JSON.parse(fs.readFileSync(mpath, "utf8"));
  for (const f of m.files) {
    const b = fs.readFileSync(path.join(dir, f.path));
    f.sha256 = sha256Hex(b);
    f.bytes = b.length;
  }
  fs.writeFileSync(mpath, JSON.stringify(m));
}

const importDirs = () =>
  fs.existsSync(importsRoot(project.id))
    ? fs
        .readdirSync(importsRoot(project.id))
        .filter((n) => n.startsWith("imp-") || n.startsWith("."))
    : [];
const quarantine = () => {
  const d = path.join(projectDataDir(project.id), "quarantine", "imports");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

beforeAll(() => {
  const folder = path.join(root, "client");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject(
    {
      name: "Imports",
      folder,
      allowedAgents: [],
      rules: { readOnly: [], writable: ["output"] },
      mode: "act",
    },
    { createdBy: "device:admin" },
  );
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

describe("vendor import pipeline", () => {
  it.each([
    ["google-mat", "google-mat-neo4j", "VERIFIED_FROM_DOCS"],
    ["aws-transform", "aws-transform-requirements", "VERIFIED_FROM_DOCS"],
    ["ibm-z", "ibm-z-docgen", "VERIFIED_FROM_DOCS"],
    ["ibm-z", "ibm-z-rules-mapped", "UNVERIFIED_SCHEMA"],
    ["aws-transform", "aws-transform-deps-mapped", "UNVERIFIED_SCHEMA"],
  ])(
    "imports %s %s with origin, hashes, provenance and signed evidence (AC-034)",
    async (provider, fixture, verification) => {
      const seen: string[] = [];
      const r = await run(provider, await zipFolder(path.join(FIXTURES, fixture)), {
        scanner: scanner("clean", seen),
      });
      if (r.status !== "imported") {
        throw new Error(JSON.stringify(r));
      }
      const rec = r.record;
      expect(rec).toMatchObject({
        provider,
        verification,
        provenance: "IMPORTED_VENDOR_ARTEFACT",
        confidence: "UNVERIFIED",
        importedBy: "main",
        scan: { scanner: "clamav", verdict: "clean" },
        bundle: { kind: "zip" },
      });
      expect(rec.bundle.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rec.manifest.origin).toMatchObject({ exportedBy: "alice", authorisedBy: "ops-lead" });
      expect(rec.docs[0]).toMatch(/^https:\/\//);
      // The scanner saw a quarantined copy in the Project's state, never the client folder.
      expect(seen[0]).toContain(path.join("quarantine", "imports"));
      expect(seen[0].startsWith(project.folder)).toBe(false);
      const dir = path.join(importsRoot(project.id), r.importId);
      for (const f of rec.manifest.files) {
        expect(fs.existsSync(path.join(dir, "objects", f.sha256))).toBe(true);
      }
      const v = await verifyEvidenceBundle(path.join(dir, "evidence"));
      expect(v.ok).toBe(true);
      expect(quarantine()).toEqual([]);
    },
  );

  it("is idempotent: a re-import or a concurrent import yields one record (AC-032)", async () => {
    const before = listImports(project.id).length;
    const zip = await zipFolder(path.join(FIXTURES, "google-mat-neo4j"));
    const again = await run("google-mat", zip);
    expect(again.status).toBe("duplicate");
    // The same files as a folder have the same idempotency key.
    const folder = await run("google-mat", path.join(FIXTURES, "google-mat-neo4j"));
    expect(folder.status).toBe("duplicate");
    // A changed export is a new import; two racing imports of it produce one record.
    const dir = copyFixture("google-mat-neo4j");
    fs.appendFileSync(
      path.join(dir, "graph", "assessment.jsonl"),
      '{"type":"node","id":"prog-NEW","labels":["Program"],"properties":{"name":"NEWPROG"}}\n',
    );
    reManifest(dir);
    const [a, b] = await Promise.all([run("google-mat", dir), run("google-mat", dir)]);
    expect([a.status, b.status].toSorted()).toEqual(["duplicate", "imported"]);
    expect(a.status !== "refused" && b.status !== "refused" && a.importId === b.importId).toBe(
      true,
    );
    expect(listImports(project.id).length).toBe(before + 1);
    expect(importDirs().filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("rejects a tampered file, an extra file and a missing file (AC-035)", async () => {
    const tampered = copyFixture("aws-transform-requirements");
    fs.appendFileSync(
      path.join(tampered, "payroll", "requirements.md"),
      "- REQ-9.9: The system shall pay double.\n",
    );
    const extra = copyFixture("aws-transform-requirements");
    fs.writeFileSync(path.join(extra, "payload.sh"), "#!/bin/sh\n");
    const missing = copyFixture("aws-transform-requirements");
    fs.rmSync(path.join(missing, "payroll", "requirements.md"));
    const before = importDirs();
    for (const [dir, msg] of [
      [tampered, /size mismatch|SHA-256 mismatch/],
      [extra, /not in the manifest/],
      [missing, /missing from the bundle/],
    ] as const) {
      const r = await run("aws-transform", dir);
      expect(r).toMatchObject({
        status: "refused",
        code: "ARTEFACT_INTEGRITY_FAILED",
        stage: "manifest",
      });
      expect(r.status === "refused" && r.reason).toMatch(msg);
      expect(r.status === "refused" && r.evidence).toBeTruthy();
    }
    // Same size, different bytes: only the hash catches it.
    const sameSize = copyFixture("aws-transform-requirements");
    const req = path.join(sameSize, "payroll", "requirements.md");
    fs.writeFileSync(
      req,
      fs.readFileSync(req, "utf8").replace("1.5", "2.5").replace("REQ-1.1", "REQ-1.7"),
    );
    const r = await run("aws-transform", sameSize);
    expect(r.status === "refused" && r.reason).toMatch(/SHA-256 mismatch/);
    expect(importDirs()).toEqual(before);
  });

  it("rejects a traversal archive and a malicious archive, with verifiable refusal evidence (AC-035)", async () => {
    const before = importDirs();
    const evil = await zipFolder(path.join(FIXTURES, "google-mat-neo4j"), (p) =>
      p === "kurahi-import.json" ? p : `zz/${p}`,
    );
    const raw = fs.readFileSync(evil);
    let i = raw.indexOf("zz/");
    while (i >= 0) {
      raw.write("../", i, "latin1");
      i = raw.indexOf("zz/", i + 1);
    }
    fs.writeFileSync(evil, raw);
    const trav = await run("google-mat", evil);
    expect(trav).toMatchObject({
      status: "refused",
      stage: "bundle",
      code: "ARTEFACT_INTEGRITY_FAILED",
    });

    const infected = await run("google-mat", path.join(FIXTURES, "google-mat-neo4j"), {
      scanner: scanner("infected"),
    });
    expect(infected).toMatchObject({ status: "refused", stage: "scan", code: "POLICY_DENIED" });
    expect(infected.status === "refused" && infected.reason).toMatch(/Eicar-Test-Signature/);
    if (infected.status !== "refused" || !infected.evidence) {
      throw new Error("no evidence");
    }
    const v = await verifyEvidenceBundle(
      path.join(importsRoot(project.id), infected.evidence.bundle),
    );
    expect(v.ok).toBe(true);

    for (const verdict of ["error", "unscanned"] as const) {
      const r = await run("google-mat", path.join(FIXTURES, "google-mat-neo4j"), {
        scanner: scanner(verdict),
      });
      expect(r, verdict).toMatchObject({ status: "refused", stage: "scan", code: "POLICY_DENIED" });
    }
    expect(importDirs()).toEqual(before);
    expect(quarantine()).toEqual([]);
  });

  it("flags an unknown schema as unsupported and stores nothing (AC-036)", async () => {
    const before = importDirs();
    const dir = copyFixture("google-mat-neo4j");
    fs.writeFileSync(
      path.join(dir, "graph", "assessment.jsonl"),
      '{"nodes":[{"name":"PAYCALC"}],"edges":[]}\n',
    );
    reManifest(dir);
    const r = await run("google-mat", dir);
    expect(r).toMatchObject({ status: "refused", stage: "parse", code: "SCHEMA_REJECTED" });
    // An unverified format without its mapping file is refused, not parsed by a guessed schema.
    const nomap = copyFixture("ibm-z-rules-mapped");
    const mpath = path.join(nomap, "kurahi-import.json");
    const m = JSON.parse(fs.readFileSync(mpath, "utf8"));
    m.files = m.files.filter((f: { role: string }) => f.role !== "mapping");
    fs.writeFileSync(mpath, JSON.stringify(m));
    fs.rmSync(path.join(nomap, "kurahi-mapping.json"));
    const r2 = await run("ibm-z", nomap);
    expect(r2).toMatchObject({ status: "refused", code: "SCHEMA_REJECTED" });
    expect(r2.status === "refused" && r2.reason).toMatch(/no published schema/);
    // A manifest for an export format the registry does not know.
    const unk = copyFixture("google-mat-neo4j");
    const up = path.join(unk, "kurahi-import.json");
    fs.writeFileSync(up, fs.readFileSync(up, "utf8").replace('"neo4j-jsonl"', '"html-report"'));
    expect(await run("google-mat", unk)).toMatchObject({
      status: "refused",
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(importDirs()).toEqual(before);
  });

  it("blocks a disabled provider before reading the bundle (AC-031)", async () => {
    const stages: ImportStage[] = [];
    const r = await run("aws-transform-remote", path.join(FIXTURES, "aws-transform-requirements"), {
      onStage: (s) => stages.push(s),
    });
    expect(r).toMatchObject({ status: "refused", stage: "gate", code: "CAPABILITY_UNAVAILABLE" });
    expect(stages).toEqual([]);
    const wrong = await run("google-mat", path.join(FIXTURES, "aws-transform-requirements"));
    expect(wrong).toMatchObject({ status: "refused", code: "SCHEMA_REJECTED" });
    expect(wrong.status === "refused" && wrong.reason).toMatch(
      /manifest is for provider "aws-transform"/,
    );
  });

  it.each(["bundle", "manifest", "scan", "parse", "store"] as ImportStage[])(
    "cancelled at %s: refused as CANCELLED, nothing stored or left in quarantine (AC-033)",
    async (at) => {
      const dir = copyFixture("ibm-z-docgen");
      fs.appendFileSync(
        path.join(dir, "Documentation", "programs", "PAYCALC.md"),
        `\n<!-- ${at} -->\n`,
      );
      reManifest(dir);
      const before = importDirs();
      const ctl = new AbortController();
      const r = await run("ibm-z", dir, {
        signal: ctl.signal,
        onStage: (s) => {
          if (s === at) {
            ctl.abort();
          }
        },
      });
      expect(r).toMatchObject({ status: "refused", stage: "cancelled", code: "CANCELLED" });
      expect(importDirs()).toEqual(before);
      expect(quarantine()).toEqual([]);
      // The same bundle imports cleanly afterwards.
      expect((await run("ibm-z", dir)).status).toBe("imported");
    },
  );

  it("shows imported data to inventory and impact, labelled as unverified vendor claims", () => {
    const inv = importedInventory(project.id, "PAYCALC");
    expect(inv.note).toMatch(/unverified/);
    const docgen = inv.imports.find((i) => i.format === "understand-docgen-md");
    expect(docgen?.items.map((i) => i.kind)).toContain("program");
    expect(docgen?.rules?.length).toBeGreaterThan(0);
    const impact = importedImpact(project.id, "paycalc");
    expect(impact).not.toBeNull();
    const g = impact!.imports.find((i) => i.format === "neo4j-jsonl")!;
    expect(g.verification).toBe("VERIFIED_FROM_DOCS");
    expect(g.upstream.map((e) => `${e.fromName} ${e.relation}`)).toEqual(["PAYJOB EXECUTES"]);
    expect(g.downstream.map((e) => `${e.relation} ${e.toName}`)).toEqual([
      "CALLS TAXCALC",
      "READS PAY.MASTER",
      "QUERIES db-EMPLOYEE",
    ]);
    for (const e of [...g.upstream, ...g.downstream]) {
      expect(e).toMatchObject({ provenance: "IMPORTED_VENDOR_ARTEFACT", confidence: "UNVERIFIED" });
    }
    expect(importedImpact(project.id, "NO-SUCH-THING")?.imports).toEqual([]);
  });
});
