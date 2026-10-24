import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkToolPermission } from "../agents/permissions.js";
import { collapseDocumentBlocks, stripProjectContext } from "../gateway/chat-sanitize.js";
import {
  addArtifactVersion,
  getArtifact,
  isKnownIdentity,
  listArtifacts,
  saveArtifact,
  setArtifactStatus,
  sha256Hex,
} from "./artifacts.js";
import {
  loadArchivedChats,
  messageTextOf,
  searchChatTranscripts,
  setChatArchived,
} from "./chats.js";
import {
  extractText,
  MAX_UPLOAD_BYTES,
  safeFileName,
  sniffKind,
  validateDocument,
} from "./documents.js";
import {
  effectiveWritable,
  parseProjectSessionKey,
  projectContextForAgent,
  projectPermissionSet,
  projectSessionKey,
} from "./scope.js";
import {
  cleanRelPath,
  createProject,
  getProject,
  isAgentAllowed,
  loadProjects,
  projectDataDir,
  updateProject,
  validateProjectFolder,
} from "./store.js";
import { loadTemplates, loadTerminalProfiles, resolveTemplatesDir } from "./templates.js";
import {
  appendChunk,
  beginUpload,
  commitUpload,
  MAX_CHUNK_BYTES,
  resetUploadsForTest,
} from "./uploads.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-projects-test-"));
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

function makePack(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "source"), { recursive: true });
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  fs.writeFileSync(path.join(dir, "source", "PAYCALC.cbl"), "       IDENTIFICATION DIVISION.\n");
  return dir;
}

const legacyRules = {
  readOnly: ["source", "data"],
  writable: ["output"],
  artifactApprovalRequired: true,
  instructions: [{ en: "Write only to output/.", ja: "output/ のみに書き込む。" }],
};

describe("project store", () => {
  it("creates, updates, archives and persists projects", () => {
    const folder = makePack("store-pack");
    const p = createProject(
      { name: "Payroll", folder, allowedAgents: ["main", "bad id!"], rules: legacyRules },
      { createdBy: "owner", home },
    );
    expect(p.id).toMatch(/^p[a-z0-9]{10}$/);
    expect(p.allowedAgents).toEqual(["main"]);
    expect(p.folder).toBe(fs.realpathSync(folder));
    expect(fs.existsSync(path.join(projectDataDir(p.id, home), "attachments"))).toBe(true);
    expect(getProject(p.id, home)?.name).toBe("Payroll");
    const u = updateProject(p.id, { name: "Payroll v2", archived: true }, { home });
    expect(u.name).toBe("Payroll v2");
    expect(u.archived).toBe(true);
    expect(loadProjects(home).find((x) => x.id === p.id)?.archived).toBe(true);
    expect(() => updateProject("pzzzzzzzzzz", { name: "x" }, { home })).toThrow(/not found/);
  });

  it("validates the project folder", () => {
    expect(() => validateProjectFolder("relative/dir", home)).toThrow(/absolute/);
    expect(() => validateProjectFolder(path.join(tmpRoot, "missing"), home)).toThrow(
      /does not exist/,
    );
    expect(() => validateProjectFolder("/", home)).toThrow(/root/);
    expect(() => validateProjectFolder(os.homedir(), home)).toThrow(/home directory/);
    fs.mkdirSync(path.join(home, "inside"), { recursive: true });
    expect(() => validateProjectFolder(path.join(home, "inside"), home)).toThrow(/state directory/);
    const withKeys = path.join(tmpRoot, "packs");
    fs.mkdirSync(path.join(withKeys, "_answer-keys", "a"), { recursive: true });
    expect(() => validateProjectFolder(withKeys, home)).toThrow(/excluded/);
    expect(() => validateProjectFolder(path.join(withKeys, "_answer-keys"), home)).toThrow(
      /excluded/,
    );
    // Windows does not allow "*" in folder names; the rule is still exercised on POSIX.
    if (process.platform !== "win32") {
      const glob = path.join(tmpRoot, "we*ird");
      fs.mkdirSync(glob);
      expect(() => validateProjectFolder(glob, home)).toThrow(/may not contain/);
    }
  });

  it("refuses the home directory even when HOME goes through a symlink", () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "proj-home-real-"));
    const alias = `${realHome}-alias`;
    fs.symlinkSync(realHome, alias, "dir");
    const prev = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = alias;
    process.env.USERPROFILE = alias;
    try {
      expect(() => validateProjectFolder(alias, home)).toThrow(/home directory/);
      expect(() => validateProjectFolder(realHome, home)).toThrow(/home directory/);
    } finally {
      process.env.HOME = prev;
      process.env.USERPROFILE = prevProfile;
      fs.rmSync(alias, { force: true });
      fs.rmSync(realHome, { recursive: true, force: true });
    }
  });

  it("cleans folder-relative paths", () => {
    expect(cleanRelPath("output/")).toBe("output");
    expect(cleanRelPath(".")).toBe(".");
    expect(cleanRelPath("../etc")).toBeNull();
    expect(cleanRelPath("/abs")).toBeNull();
    expect(cleanRelPath("C:\\x")).toBeNull();
    expect(cleanRelPath("a//b")).toBeNull();
  });

  it("checks allowed agents", () => {
    const base = { allowedAgents: [] as string[] } as never;
    expect(isAgentAllowed(base, "main", "main")).toBe(true);
    expect(isAgentAllowed(base, "ops", "main")).toBe(false);
    expect(isAgentAllowed({ allowedAgents: ["ops"] } as never, "ops", "main")).toBe(true);
    expect(isAgentAllowed({ allowedAgents: ["ops"] } as never, "main", "main")).toBe(false);
  });
});

describe("project scope enforcement", () => {
  const folder = makePack("scope-pack");
  const project = createProject(
    { name: "Scope", folder, rules: legacyRules },
    { createdBy: "owner", home },
  );
  const set = projectPermissionSet(project, home);
  const workspace = path.join(tmpRoot, "agent-workspace");
  const check = (toolName: string, args: Record<string, unknown>) =>
    checkToolPermission({ toolName, args, permissionSet: set, workspaceDir: workspace });
  const real = project.folder;

  it("parses project session keys", () => {
    const key = projectSessionKey("main", project.id, "k1");
    expect(parseProjectSessionKey(key)).toEqual({
      agentId: "main",
      projectId: project.id,
      chatId: "k1",
    });
    expect(parseProjectSessionKey("agent:main:main")).toBeNull();
    expect(parseProjectSessionKey("agent:main:proj-bad-k1")).toBeNull();
  });

  it("allows reads only inside the project folder and data area", () => {
    expect(check("read", { path: `${real}/source/PAYCALC.cbl` }).ok).toBe(true);
    expect(
      check("read", { path: `${projectDataDir(project.id, home)}/attachments/a.pdf` }).ok,
    ).toBe(true);
    expect(check("read", { path: "/etc/passwd" }).ok).toBe(false);
    expect(check("read", { path: `${real}/../other/file` }).ok).toBe(false);
    expect(check("read", { path: "relative.txt" }).ok).toBe(false);
  });

  it("allows writes only in writable folders", () => {
    expect(check("write", { path: `${real}/output/rules.md` }).ok).toBe(true);
    expect(check("write", { path: `${real}/source/PAYCALC.cbl` }).ok).toBe(false);
    expect(check("edit", { path: `${real}/data/x.csv` }).ok).toBe(false);
    expect(check("write", { path: "/tmp/x" }).ok).toBe(false);
  });

  it("denies exec and excluded folders", () => {
    expect(check("exec", { command: "ls" }).ok).toBe(false);
    expect(check("read", { path: `${real}/_answer-keys/rules.json` }).ok).toBe(false);
    const d = check("read", { path: `${real}/_answer-keys/x` });
    expect(d.ok ? "" : d.reason).toMatch(/project "Scope"/);
  });

  it("drops writable entries that overlap read-only ones", () => {
    expect(
      effectiveWritable({ rules: { ...legacyRules, writable: ["output", "source/gen", "."] } }),
    ).toEqual(["output"]);
  });

  it("gives the agent the project context, hidden from history", () => {
    const ctx = projectContextForAgent(project);
    expect(ctx).toContain(real);
    expect(ctx).toContain("Write only to output/.");
    expect(stripProjectContext(`${ctx}\n\n[Tue 10:00] hello`)).toBe("[Tue 10:00] hello");
    expect(
      collapseDocumentBlocks(
        'read this\n\n[[kurahi-document name="契約書.pdf" kind="pdf" path="/x"]]\nsecret text\n[[/kurahi-document]]',
      ),
    ).toBe("read this\n\n[Attached document: 契約書.pdf]");
  });
});

describe("templates", () => {
  const dir = resolveTemplatesDir({});

  it("loads the templates from data files", () => {
    const templates = loadTemplates(dir);
    expect(templates.map((t) => t.id).toSorted()).toEqual([
      "business-finance-expense-invoice",
      "business-general-affairs",
      "business-hr-leave-overtime",
      "business-procurement",
      "education",
      "industry-legacy-modernisation",
      "professional",
      "research-academic",
    ]);
    for (const t of templates) {
      expect(t.name.ja && t.name.en).toBeTruthy();
      expect(t.starterPrompts.length).toBeGreaterThan(0);
      expect(t.rules.writable).toEqual(["output"]);
    }
    const legacy = templates.find((t) => t.id === "industry-legacy-modernisation");
    expect(legacy?.rules.readOnly).toContain("source");
    expect(legacy?.rules.artifactApprovalRequired).toBe(true);
    expect(legacy?.terminalProfile).toBe("legacy");
    expect(templates.find((t) => t.id === "professional")?.terminalProfile).toBe("data");
  });

  it("defines the six terminal profiles, all off by default", () => {
    const profiles = loadTerminalProfiles(dir);
    expect(profiles.map((p) => p.id)).toEqual([
      "standard",
      "data",
      "operations",
      "legacy",
      "scientific",
      "learning-sandbox",
    ]);
    expect(profiles.every((p) => !p.enabledByDefault && !p.clientIsolated && !p.justInTime)).toBe(
      true,
    );
    expect(profiles.find((p) => p.id === "scientific")?.label.ja).toBe("科学計算");
  });

  it("creates a project from a template with its folders and rules", () => {
    const tpl = loadTemplates(dir).find((t) => t.id === "research-academic");
    const folder = path.join(tmpRoot, "research");
    fs.mkdirSync(path.join(folder, "corpus"), { recursive: true });
    const p = createProject(
      { name: "Review", folder },
      { createdBy: "owner", template: tpl, home },
    );
    expect(p.templateId).toBe("research-academic");
    expect(p.rules.readOnly).toEqual(["corpus"]);
    expect(p.terminalProfile).toBe("scientific");
    expect(fs.existsSync(path.join(folder, "output"))).toBe(true);
  });
});

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(
    "word/document.xml",
    `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; last</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    '<workbook><sheets><sheet name="Pay" sheetId="1"/></sheets></workbook>',
  );
  zip.file(
    "xl/sharedStrings.xml",
    "<sst><si><t>Name</t></si><si><t>Rate</t></si><si><t>田中</t></si></sst>",
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1.25</v></c></row></sheetData></worksheet>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("document validation and extraction", () => {
  it("checks type by magic bytes against the extension", async () => {
    expect((await validateDocument("a.pdf", Buffer.from("%PDF-1.7\n..."))).ok).toBe(true);
    expect((await validateDocument("a.pdf", Buffer.from("hello"))).ok).toBe(false);
    expect((await validateDocument("a.txt", Buffer.from("%PDF-1.7"))).ok).toBe(false);
    expect((await validateDocument("notes.md", Buffer.from("# 見出し\n本文"))).ok).toBe(true);
    expect((await validateDocument("data.csv", Buffer.from("a,b\n1,2"))).ok).toBe(true);
    expect((await validateDocument("bin.txt", Buffer.from([0x41, 0x00, 0x42]))).ok).toBe(false);
    expect((await validateDocument("x.exe", Buffer.from("MZ"))).ok).toBe(false);
    expect((await validateDocument("e.txt", Buffer.alloc(0))).ok).toBe(false);
    const docx = await makeDocx("Hello");
    expect((await validateDocument("c.docx", docx)).ok).toBe(true);
    expect((await validateDocument("c.xlsx", docx)).ok).toBe(false);
    expect(await sniffKind(await makeXlsx())).toBe("xlsx");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect((await validateDocument("p.png", png)).ok).toBe(true);
    expect((await validateDocument("p.jpg", png)).ok).toBe(false);
  });

  it("enforces the size limit", async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61);
    const r = await validateDocument("big.txt", big);
    expect(r.ok).toBe(false);
  });

  it("extracts text from docx and xlsx", async () => {
    expect(await extractText("docx", await makeDocx("Hello"))).toBe("Hello\nSecond & last");
    expect(await extractText("xlsx", await makeXlsx())).toBe("## Pay\nName,Rate\n田中,1.25");
    expect(await extractText("txt", Buffer.from("\uFEFFplain"))).toBe("plain");
  });

  it("makes safe file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\契約書.docx")).toBe("契約書.docx");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("a<b>.txt")).toBe("a_b_.txt");
  });
});

describe("chunked upload", () => {
  beforeEach(() => resetUploadsForTest());

  it("stores in the project attachments area and returns extracted text", async () => {
    const folder = makePack("upload-pack");
    const project = createProject({ name: "Up", folder }, { createdBy: "owner", home });
    const content = Buffer.from("line one\n二行目\n");
    const { uploadId } = beginUpload(
      { name: "../notes.md", size: content.length, projectId: project.id },
      "owner",
    );
    appendChunk({ uploadId, seq: 0, data: content.toString("base64") }, "owner");
    const doc = await commitUpload({ uploadId }, "owner", { home });
    expect(doc.kind).toBe("md");
    expect(doc.path.startsWith(path.join(projectDataDir(project.id, home), "attachments"))).toBe(
      true,
    );
    expect(path.basename(doc.path)).toMatch(/-notes\.md$/);
    expect(doc.text).toContain("二行目");
    expect(fs.existsSync(`${doc.path}.extracted.txt`)).toBe(true);
  });

  it("uses the scratch area without a project and rejects bad uploads", async () => {
    const data = Buffer.from("a,b\n1,2\n");
    const { uploadId } = beginUpload({ name: "t.csv", size: data.length }, "device:abc");
    appendChunk({ uploadId, seq: 0, data: data.toString("base64") }, "device:abc");
    const doc = await commitUpload({ uploadId }, "device:abc", { home });
    expect(doc.path).toContain(path.join(home, "scratch", "device_abc", "attachments"));

    expect(() => beginUpload({ name: "x.exe", size: 10 }, "owner")).toThrow(/unsupported/);
    expect(() => beginUpload({ name: "x.pdf", size: MAX_UPLOAD_BYTES + 1 }, "owner")).toThrow(
      /size/,
    );
    expect(() =>
      beginUpload({ name: "x.pdf", size: 10, projectId: "pzzzzzzzzzz" }, "owner"),
    ).toThrow(/project/);

    const second = beginUpload({ name: "fake.pdf", size: 5 }, "owner");
    expect(() =>
      appendChunk({ uploadId: second.uploadId, seq: 1, data: "aGVsbG8=" }, "owner"),
    ).toThrow(/order/);
    expect(() =>
      appendChunk({ uploadId: second.uploadId, seq: 0, data: "aGVsbG8=" }, "someone-else"),
    ).toThrow(/unknown/);
    appendChunk({ uploadId: second.uploadId, seq: 0, data: "aGVsbG8=" }, "owner");
    await expect(commitUpload({ uploadId: second.uploadId }, "owner", { home })).rejects.toThrow(
      /does not match/,
    );

    const third = beginUpload({ name: "a.txt", size: 2 }, "owner");
    expect(() =>
      appendChunk({ uploadId: third.uploadId, seq: 0, data: "aGVsbG8=" }, "owner"),
    ).toThrow(/more data/);
    expect(MAX_CHUNK_BYTES).toBe(256 * 1024);
  });
});

describe("artifacts", () => {
  it("versions content with SHA-256 and enforces the review flow", () => {
    const a = saveArtifact(
      {
        title: "Overtime rules",
        type: "document",
        content: "# Rules\n1. x",
        sourceSession: "agent:main:main",
      },
      "device:aaaa",
      { home },
    );
    expect(a.status).toBe("draft");
    expect(a.versions[0]).toMatchObject({
      version: 1,
      sha256: sha256Hex("# Rules\n1. x"),
      createdByAgent: null,
    });
    expect(() =>
      setArtifactStatus({ id: a.id, status: "approved" }, "device:bbbb", { home }),
    ).toThrow(/cannot change/);
    setArtifactStatus({ id: a.id, status: "review" }, "device:aaaa", { home });
    expect(() =>
      setArtifactStatus({ id: a.id, status: "approved" }, "device:aaaa", { home }),
    ).toThrow(/different user/);
    const approved = setArtifactStatus({ id: a.id, status: "approved" }, "device:bbbb", { home });
    expect(approved.status).toBe("approved");
    expect(approved.history.at(-1)).toMatchObject({
      by: "device:bbbb",
      from: "review",
      to: "approved",
    });

    expect(() =>
      addArtifactVersion({ id: a.id, content: "# Rules\n1. x" }, "device:aaaa", { home }),
    ).toThrow(/identical/);
    const v2 = addArtifactVersion({ id: a.id, content: "# Rules\n1. y" }, "device:aaaa", { home });
    expect(v2.versions).toHaveLength(2);
    expect(v2.status).toBe("draft");
    expect(getArtifact(a.id, 1, { home }).content).toBe("# Rules\n1. x");
    expect(getArtifact(a.id, null, { home })).toMatchObject({
      version: 2,
      content: "# Rules\n1. y",
    });
  });

  it("records the approver when identities are not known", () => {
    const a = saveArtifact({ title: "Draft", content: "x" }, "owner", { home });
    setArtifactStatus({ id: a.id, status: "review" }, "owner", { home });
    const ok = setArtifactStatus({ id: a.id, status: "approved" }, "owner", { home });
    expect(ok.history.at(-1)?.by).toBe("owner");
    expect(isKnownIdentity("owner")).toBe(false);
    expect(isKnownIdentity("pair:abc")).toBe(true);
  });

  it("detects tampering and filters lists", () => {
    const a = saveArtifact({ title: "T", content: "orig", format: "txt" }, "owner", { home });
    fs.writeFileSync(path.join(home, "artifacts", a.id, "v1.txt"), "tampered");
    expect(() => getArtifact(a.id, 1, { home })).toThrow(/SHA-256/);
    expect(
      listArtifacts({ status: "approved" }, { home }).every((x) => x.status === "approved"),
    ).toBe(true);
    expect(() => saveArtifact({ title: "", content: "x" }, "owner", { home })).toThrow(/title/);
    expect(() =>
      saveArtifact({ title: "x", content: "y", projectId: "pzzzzzzzzzz" }, "owner", { home }),
    ).toThrow(/project/);
  });
});

describe("chat history helpers", () => {
  it("archives chats and searches transcript text", () => {
    expect(setChatArchived("agent:main:main", true, home)).toEqual(["agent:main:main"]);
    expect(loadArchivedChats(home)).toEqual(["agent:main:main"]);
    setChatArchived("agent:main:main", false, home);
    expect(loadArchivedChats(home)).toEqual([]);
    expect(() => setChatArchived("not a key", true, home)).toThrow();

    const sessions = path.join(home, "agents", "main", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "s1" },
        "agent:main:other": { sessionId: "s2" },
      }),
    );
    const line = (role: string, text: string) =>
      JSON.stringify({ message: { role, content: [{ type: "text", text }] } });
    fs.writeFileSync(
      path.join(sessions, "s1.jsonl"),
      `${line("user", "残業の計算ルール")}\n${line("assistant", "Overtime is 1.25x")}\n`,
    );
    fs.writeFileSync(path.join(sessions, "s2.jsonl"), `${line("user", "hello")}\n`);
    expect(searchChatTranscripts("overtime", home)).toEqual(["agent:main:main"]);
    expect(searchChatTranscripts("残業", home)).toEqual(["agent:main:main"]);
    expect(searchChatTranscripts("x", home)).toEqual([]);
    expect(
      messageTextOf(`${JSON.stringify({ message: { role: "toolResult", content: "secret" } })}\n`),
    ).toBe("");
  });
});
