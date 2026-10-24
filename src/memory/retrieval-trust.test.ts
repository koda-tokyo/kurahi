import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBootstrapFilesForRun } from "../agents/bootstrap-files.js";
import { buildMemoryContextContent } from "../agents/memory-inject.js";
import {
  __testing,
  appendProvenanceRecord,
  memoryPathKey,
  resolveProvenanceDir,
  sha256File,
  type MemoryProvenanceRecord,
  type MemoryTrustLevel,
} from "./provenance.js";
import {
  markReadResult,
  markSearchResults,
  resolveTrustMarkContext,
  UNVERIFIED_MEMORY_NOTICE,
} from "./retrieval-trust.js";

let home: string;
let ws: string;
const prevEnv = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-memtrust-"));
  process.env.KOLO_HOME = home;
  ws = path.join(home, "workspace");
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  __testing.resetCache();
});

afterEach(() => {
  process.env = { ...prevEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

function writeTagged(rel: string, content: string, trust: MemoryTrustLevel) {
  const abs = path.join(ws, rel);
  fs.writeFileSync(abs, content);
  const rec: MemoryProvenanceRecord = {
    v: 1,
    id: `id-${rel}`,
    ts: new Date().toISOString(),
    agentId: "main",
    sessionKey: "agent:main:main",
    jobId: null,
    trust,
    trustReasons: ["test"],
    tool: "write",
    op: "write",
    path: memoryPathKey(abs),
    contentSha256: "x",
    fileSha256After: sha256File(abs),
    status: "active",
  };
  appendProvenanceRecord(resolveProvenanceDir("main"), rec);
  return abs;
}

const ctx = () => ({ agentId: "main", workspaceDir: ws });
const result = (p: string, snippet: string) => ({
  path: p,
  snippet,
  score: 0.9,
  startLine: 1,
  endLine: 1,
  source: "memory",
});

describe("retrieval marking", () => {
  it("marks legacy entries without provenance as unverified", () => {
    fs.writeFileSync(path.join(ws, "MEMORY.md"), "old note\n");
    const [r] = markSearchResults([result("MEMORY.md", "old note")], ctx());
    expect(r.trust).toBe("unverified");
    expect(r.snippet.startsWith(UNVERIFIED_MEMORY_NOTICE)).toBe(true);
  });

  it("leaves operator entries plain and wraps external-origin entries in untrusted markers", () => {
    writeTagged("memory/mine.md", "my note\n", "operator");
    writeTagged("memory/web.md", "from a page\n", "external");
    const [mine, web] = markSearchResults(
      [result("memory/mine.md", "my note"), result("memory/web.md", "from a page")],
      ctx(),
    );
    expect(mine).toMatchObject({ trust: "operator", snippet: "my note" });
    expect(web.trust).toBe("external");
    expect(web.snippet).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(web.snippet).toContain("Memory (external origin)");
    expect(web.snippet).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>");
  });

  it("an entry changed outside the recorded writes becomes unverified", () => {
    const abs = writeTagged("memory/mine.md", "my note\n", "operator");
    fs.appendFileSync(abs, "edited by hand\n");
    __testing.resetCache();
    const out = markReadResult({ path: "memory/mine.md", text: "my note" }, ctx());
    expect(out.trust).toBe("unverified");
    expect(out.provenance).toMatch(/changed since/);
  });

  it("session transcripts are never presented as verified memory", () => {
    const [r] = markSearchResults(
      [{ ...result("sessions/a.jsonl", "chat"), source: "sessions" }],
      ctx(),
    );
    expect(r.trust).toBe("unverified");
  });

  it("is off with memory.provenance.mode off", () => {
    expect(
      resolveTrustMarkContext({
        config: { memory: { provenance: { mode: "off" } } },
        agentId: "main",
        workspaceDir: ws,
      }),
    ).toBeNull();
    const [r] = markSearchResults([result("MEMORY.md", "x")], null);
    expect(r).not.toHaveProperty("trust");
  });

  it("automatic recall shows the trust of each snippet", () => {
    writeTagged("memory/web.md", "from a page\n", "external");
    const content = buildMemoryContextContent([result("memory/web.md", "from a page")], ctx());
    expect(content).toContain("trust: external");
    expect(content).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
  });

  it("boot injection marks MEMORY.md by trust", async () => {
    fs.writeFileSync(path.join(ws, "MEMORY.md"), "legacy boot memory\n");
    const files = await resolveBootstrapFilesForRun({
      workspaceDir: ws,
      config: {},
      sessionKey: "agent:main:main",
    });
    const memory = files.find((f) => f.name === "MEMORY.md");
    expect(memory?.content?.startsWith(UNVERIFIED_MEMORY_NOTICE)).toBe(true);
    expect(files.find((f) => f.name === "AGENTS.md")?.content ?? "").not.toContain(
      UNVERIFIED_MEMORY_NOTICE,
    );
  });
});
