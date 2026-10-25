import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { FileScanner, ScanVerdict } from "./scanner.js";
import { flushAudit, resolveAuditDir } from "../audit/audit-log.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { createProject, getProject, projectDataDir, setProjectMode } from "../projects/store.js";
import {
  type AttachmentSecurityConfig,
  INBOX_ATTACHMENTS_DIR,
  intakeAttachment,
  resolveAttachmentSecurity,
} from "./attachment-intake.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-intake-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

let project: Project;
const CFG: AttachmentSecurityConfig = {
  scanner: "auto",
  requireScan: true,
  scanTimeoutMs: 2000,
  extractTimeoutMs: 60_000,
  extractMaxOldSpaceMb: 256,
};
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** A scanner fake that records what the file system looked like while it ran. */
function fake(
  verdict: ScanVerdict["verdict"] | "hang" | "throw",
  seen: { files: string[]; inbox: string[]; insideFolder: boolean }[] = [],
): FileScanner {
  return {
    name: "clamav",
    async scan(file) {
      const inbox = path.join(project.folder, INBOX_ATTACHMENTS_DIR);
      seen.push({
        files: [file],
        inbox: fs.existsSync(inbox) ? fs.readdirSync(inbox) : [],
        insideFolder: path.resolve(file).startsWith(path.resolve(project.folder)),
      });
      if (verdict === "hang") {
        return new Promise(() => {});
      }
      if (verdict === "throw") {
        throw new Error("engine crashed");
      }
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

const input = (name: string, bytes: Buffer | string) => ({
  project: getProject(project.id)!,
  connector: "microsoft-365",
  messageId: "AAMkMSG1",
  attachmentId: "AAMkATT1",
  name,
  bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
  actor: "main",
});

const inboxFiles = () => {
  const dir = path.join(project.folder, INBOX_ATTACHMENTS_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
};
const quarantine = () => {
  const dir = path.join(projectDataDir(project.id), "quarantine", "attachments");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

beforeAll(() => {
  const folder = path.join(root, "client");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject(
    {
      name: "Intake",
      folder,
      allowedAgents: [],
      rules: { readOnly: [], writable: [INBOX_ATTACHMENTS_DIR, "output"] },
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

describe("attachment intake", () => {
  it("clean: stored in inbox-attachments only after the verdict; text extracted; quarantine emptied", async () => {
    const seen: Parameters<typeof fake>[1] = [];
    const r = await intakeAttachment(input("見積書.txt", "お見積りは 12,000 円です"), {
      config: CFG,
      scanner: fake("clean", seen),
    });
    expect(r).toMatchObject({
      status: "accepted",
      kind: "txt",
      verdict: "clean",
      scanner: "clamav",
    });
    if (r.status !== "accepted") {
      throw new Error("not accepted");
    }
    // While the scanner ran, the file was in the quarantine area outside the client folder and
    // nothing was in inbox-attachments yet.
    expect(seen[0].insideFolder).toBe(false);
    expect(seen[0].files[0]).toContain(path.join("quarantine", "attachments"));
    expect(seen[0].inbox).toEqual([]);
    expect(r.path.startsWith(`${INBOX_ATTACHMENTS_DIR}/`)).toBe(true);
    expect(fs.readFileSync(path.join(project.folder, r.path), "utf8")).toBe(
      "お見積りは 12,000 円です",
    );
    expect(r.text).toBe("お見積りは 12,000 円です");
    expect(quarantine()).toEqual([]);
    // The same file again lands on the same name (no duplicate, no overwrite of another file).
    const again = await intakeAttachment(input("見積書.txt", "お見積りは 12,000 円です"), {
      config: CFG,
      scanner: fake("clean"),
    });
    expect(again.status === "accepted" && again.path).toBe(r.path);
  }, 90_000);

  it.each([
    ["infected", "infected"],
    ["error", "scan_failed"],
    ["throw", "scan_failed"],
    ["hang", "scan_failed"],
  ] as const)("scanner %s → refused %s, nothing stored, signed evidence", async (v, code) => {
    const before = inboxFiles();
    const r = await intakeAttachment(input("eicar.txt", EICAR), {
      config: { ...CFG, scanTimeoutMs: 100 },
      scanner: fake(v),
    });
    expect(r).toMatchObject({ status: "refused", stage: "scan", code });
    expect(inboxFiles()).toEqual(before);
    expect(quarantine()).toEqual([]);
    if (r.status !== "refused" || !r.evidence) {
      throw new Error("no evidence");
    }
    const v2 = await verifyEvidenceBundle(path.join(projectDataDir(project.id), r.evidence.bundle));
    expect(v2.ok).toBe(true);
  });

  it("requireScan with no scanner refuses unscanned; requireScan false accepts it as unscanned", async () => {
    const none: FileScanner = {
      name: "none",
      scan: async () => ({
        verdict: "unscanned",
        scanner: "none",
        signature: null,
        detail: null,
        ms: 0,
      }),
    };
    expect(
      await intakeAttachment(input("a.txt", "a"), { config: CFG, scanner: none }),
    ).toMatchObject({ status: "refused", code: "unscanned" });
    expect(
      await intakeAttachment(input("b.txt", "b"), {
        config: { ...CFG, requireScan: false },
        scanner: none,
      }),
    ).toMatchObject({ status: "accepted", verdict: "unscanned", scanner: "none" });
  }, 60_000);

  it("the static policy runs before (and without) the scanner", async () => {
    const seen: Parameters<typeof fake>[1] = [];
    const r = await intakeAttachment(input("invoice.pdf", Buffer.from([0x4d, 0x5a, 0, 0])), {
      config: CFG,
      scanner: fake("clean", seen),
    });
    expect(r).toMatchObject({ status: "refused", stage: "policy", code: "executable" });
    expect(seen).toHaveLength(0);
  });

  it("respects the Project's write guards (Plan mode cannot write inbox-attachments)", async () => {
    setProjectMode(project.id, "plan");
    try {
      const r = await intakeAttachment(input("c.txt", "c"), {
        config: CFG,
        scanner: fake("clean"),
      });
      expect(r).toMatchObject({ status: "refused", stage: "store", code: "not_writable" });
    } finally {
      setProjectMode(project.id, "act");
    }
  });

  it("refuses an inbox-attachments folder that is a symbolic link", async () => {
    const other = fs.mkdtempSync(path.join(root, "elsewhere-"));
    const p2 = createProject(
      {
        name: "Link",
        folder: fs.mkdtempSync(path.join(root, "linked-")),
        allowedAgents: [],
        rules: { readOnly: [], writable: [INBOX_ATTACHMENTS_DIR] },
        mode: "act",
      },
      { createdBy: "device:admin" },
    );
    fs.symlinkSync(other, path.join(p2.folder, INBOX_ATTACHMENTS_DIR));
    const r = await intakeAttachment(
      { ...input("d.txt", "d"), project: p2 },
      { config: CFG, scanner: fake("clean") },
    );
    expect(r).toMatchObject({ status: "refused", code: "not_writable" });
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("stores into another intake folder only when it is one of the fixed names and writable", async () => {
    // corpus-inbox is not writable in this Project: refused, nothing stored anywhere.
    const r = await intakeAttachment(
      { ...input("paper.txt", "abstract"), folder: "corpus-inbox" },
      { config: CFG, scanner: fake("clean") },
    );
    expect(r).toMatchObject({ status: "refused", stage: "store", code: "not_writable" });
    expect(fs.existsSync(path.join(project.folder, "corpus-inbox"))).toBe(false);
    const r2 = await intakeAttachment(
      { ...input("paper.txt", "abstract"), folder: "../output" as never },
      { config: CFG, scanner: fake("clean") },
    );
    expect(r2).toMatchObject({ status: "refused", code: "not_writable" });
  });

  it("audits ids, hash, verdict and scanner, never the file name or content", async () => {
    await intakeAttachment(input("secret-merger-plan.txt", EICAR), {
      config: CFG,
      scanner: fake("infected"),
    });
    await flushAudit();
    const dir = resolveAuditDir();
    const text = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    const rows = text
      .split("\n")
      .filter((l) => l.includes('"attachment.intake"'))
      .map((l) => JSON.parse(l));
    const row = rows.findLast((r) => r.detail?.verdict === "infected");
    expect(row).toMatchObject({
      outcome: "denied",
      detail: {
        messageId: "AAMkMSG1",
        attachmentId: "AAMkATT1",
        scanner: "clamav",
        code: "infected",
      },
    });
    expect(row.detail.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(text).not.toContain("secret-merger-plan");
    expect(text).not.toContain("EICAR-STANDARD");
  });

  it("reads security.attachments from the config (requireScan defaults on)", () => {
    expect(resolveAttachmentSecurity({})).toMatchObject({ scanner: "auto", requireScan: true });
    expect(
      resolveAttachmentSecurity({
        security: {
          attachments: { scanner: "defender", requireScan: false, scanTimeoutSeconds: 9 },
        },
      }),
    ).toMatchObject({ scanner: "defender", requireScan: false, scanTimeoutMs: 9000 });
  });
});
