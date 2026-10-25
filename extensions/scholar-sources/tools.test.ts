import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import type { FileScanner } from "../../src/security/scanner.js";
import { flushAudit } from "../../src/audit/audit-log.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import {
  type AttachmentIntakeInput,
  intakeAttachment,
} from "../../src/security/attachment-intake.js";
import register, { SCHOLAR_TOOL_NAMES } from "./index.js";
import { dueReminders, parseDeadlines } from "./src/deadlines.js";
import { decideOpenAccess } from "./src/pdf.js";
import { fixture, json, makeTools, recorded, type Route } from "./test-helpers.js";

// Project-side behaviour: drafts read from the Project, open-access PDFs through the REAL
// attachment intake (fake scanner) into corpus-inbox/, grant reminders from knowledge/.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-scholar-"));
const home = path.join(tmpRoot, "state");
const folder = path.join(tmpRoot, "lab");
const prev = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
let sessionKey = "";
let verdict: "clean" | "infected" = "clean";
const scanner: FileScanner = {
  name: "clamav",
  async scan() {
    return {
      verdict,
      scanner: "clamav",
      signature: verdict === "infected" ? "Eicar" : null,
      detail: null,
      ms: 1,
    };
  },
};
const intakeInputs: AttachmentIntakeInput[] = [];
const intake = (input: AttachmentIntakeInput) => {
  intakeInputs.push(input);
  return intakeAttachment(input, {
    scanner,
    config: {
      scanner: "clamav",
      requireScan: true,
      scanTimeoutMs: 2000,
      extractTimeoutMs: 60_000,
      extractMaxOldSpaceMb: 256,
    },
  });
};

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

beforeAll(() => {
  process.env.KOLO_HOME = home;
  process.env.KOLO_STATE_DIR = home;
  for (const f of ["output/drafts", "knowledge", "corpus-inbox"]) {
    fs.mkdirSync(path.join(folder, f), { recursive: true });
  }
  fs.writeFileSync(
    path.join(folder, "output/drafts/paper.md"),
    [
      "# Draft",
      "## References",
      "1. LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015. doi:10.1038/nature14539",
      "2. Doe J. Invented results. Journal of Nothing. 2021. doi:10.9999/does-not-exist-kurahi",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(folder, "knowledge/grants.md"),
    [
      "# Grant deadlines",
      "<!-- - 2026-10-26 | commented out | ignored -->",
      "- 2026-11-05 | KAKENHI Grant-in-Aid (C) | internal deadline",
      "- 2026-10-28 | JST ACT-X | ",
      "- 2026-10-25 | 学内研究費 | 今日締切",
      "- 2026-09-01 | past call | gone",
      "- 2027-03-01 | far away |",
      "- not a deadline line",
    ].join("\n"),
  );
  const project = createProject(
    {
      name: "Lab",
      folder,
      rules: { readOnly: ["knowledge"], writable: ["output", "corpus-inbox"] },
      mode: "act",
    },
    { createdBy: "owner", home },
  );
  sessionKey = projectSessionKey("main", project.id, "c1");
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", prev.home],
    ["KOLO_STATE_DIR", prev.state],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const lookupFn = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

function pdfTools(routes: Route[], pdf: (url: URL) => Response) {
  const downloads: URL[] = [];
  const t = makeTools(routes, {
    ctx: { agentId: "main", sessionKey },
    extra: {
      intake,
      lookupFn,
      pinDns: false,
      pdfFetch: async (input) => {
        const u = new URL(input instanceof Request ? input.url : input);
        downloads.push(u);
        return pdf(u);
      },
    },
  });
  return { ...t, downloads };
}

describe("plugin wiring", () => {
  it("ships a valid project-scoped manifest and registers its tools only", () => {
    const res = loadPluginManifest(fileURLToPath(new URL(".", import.meta.url)));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest).toMatchObject({ id: "scholar-sources", projectScope: true });
    }
    const registered: unknown[] = [];
    register({
      pluginConfig: {},
      registerTool: (_t: unknown, opts?: { names?: string[] }) => registered.push(opts?.names),
      audit: () => {},
    } as unknown as KoLoPluginApi);
    expect(registered).toEqual([[...SCHOLAR_TOOL_NAMES]]);
  });
});

describe("scholar_cite_check on Project drafts", () => {
  it("lists draft versions, then checks one version", async () => {
    const t = makeTools(recorded, { ctx: { agentId: "main", sessionKey } });
    const list = await t.run("scholar_cite_check", { path: "output/drafts", list: true });
    const [ref] = list.details.drafts as string[];
    expect(ref).toMatch(/^[0-9a-f]{12}:output%2Fdrafts%2Fpaper\.md$/);
    expect(list.text).toContain(`1. id: ${ref}`);
    expect(t.calls).toHaveLength(0);
    const res = await t.run("scholar_cite_check", { draft: ref });
    expect(res.details.counts).toEqual({ verified: 1, mismatch: 0, not_found: 1 });
    expect(res.text).toContain("Draft output/drafts/paper.md (version");
    expect(res.text).not.toContain("changed since it was listed");
  });

  it("refuses paths outside the Project and works only in a Project session", async () => {
    const t = makeTools(recorded, { ctx: { agentId: "main", sessionKey } });
    expect((await t.run("scholar_cite_check", { path: "../../etc/passwd" })).text).toMatch(
      /^Error: /,
    );
    const outside = makeTools(recorded, { ctx: { agentId: "main" } });
    expect((await outside.run("scholar_cite_check", { path: "output/drafts" })).text).toMatch(
      /^Error: .*Project/,
    );
  });
});

describe("scholar_fetch_pdf", () => {
  it("arXiv: downloads the e-print through the intake into corpus-inbox/", async () => {
    verdict = "clean";
    const t = pdfTools(recorded, () => new Response(PDF, { status: 200 }));
    const res = await t.run("scholar_fetch_pdf", { id: "arXiv:1706.03762" });
    expect(res.details).toMatchObject({ status: "accepted", license: "arxiv" });
    const stored = res.details.path as string;
    expect(stored).toMatch(/^corpus-inbox\/\d{8}-[0-9a-f]{8}-arxiv-1706\.03762\.pdf$/);
    expect(fs.readFileSync(path.join(folder, stored)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(t.downloads[0].toString()).toBe("https://arxiv.org/pdf/1706.03762");
    expect(intakeInputs.at(-1)).toMatchObject({
      folder: "corpus-inbox",
      connector: "scholar-sources",
    });
    // The model gets the path, never the bytes or the text.
    expect(res.text).not.toContain("%PDF");
    expect(res.text).toContain(`Stored ${stored}`);
  });

  it("an open licence (OpenAlex best OA location, CC BY) is fetched; the scanner can still refuse", async () => {
    verdict = "infected";
    const work = JSON.parse(fixture("openalex-search.json")).results[0];
    const t = pdfTools(
      [(u) => (u.hostname === "api.openalex.org" ? json(work) : null), ...recorded],
      () => new Response(PDF, { status: 200 }),
    );
    const res = await t.run("scholar_fetch_pdf", { id: "10.3390/make7030089" });
    expect(t.downloads[0].hostname).toBe("www.mdpi.com");
    expect(res.details).toMatchObject({
      status: "refused",
      attachment: { status: "refused", code: "infected", messageId: "doi/10.3390/make7030089" },
    });
    expect(
      fs.readdirSync(path.join(folder, "corpus-inbox")).some((f) => f.includes("make7030089")),
    ).toBe(false);
    verdict = "clean";
  });

  it("refuses works without an open-access licence before downloading anything", async () => {
    const work = JSON.parse(fixture("openalex-search.json")).results[0];
    const closed = { ...work, open_access: { is_oa: false }, best_oa_location: null };
    const bronze = {
      ...work,
      best_oa_location: { ...work.best_oa_location, license: null },
    };
    for (const w of [closed, bronze]) {
      const t = pdfTools(
        [
          (u) => (u.hostname === "api.openalex.org" ? json(w) : null),
          (u) =>
            u.hostname === "api.crossref.org"
              ? json({ message: JSON.parse(fixture("crossref-work.json")).message })
              : null,
        ],
        () => new Response(PDF),
      );
      const res = await t.run("scholar_fetch_pdf", { id: "doi:10.3390/make7030089" });
      expect(res.details).toMatchObject({ status: "not_open_access" });
      expect(res.text).toMatch(/^Refused: .*Nothing was downloaded\.$/);
      expect(t.downloads).toHaveLength(0);
    }
    const nature = makeTools([
      (u) =>
        u.hostname === "api.crossref.org" ? json(JSON.parse(fixture("crossref-work.json"))) : null,
    ]);
    // Crossref lists a PDF link for this Nature paper, but under a TDM licence: not open access.
    expect(
      await decideOpenAccess(nature.http, { kind: "doi", value: "10.1038/nature14539" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("refuses a landing page served instead of the PDF, and private addresses", async () => {
    const t = pdfTools(recorded, () => new Response("<html>login</html>", { status: 200 }));
    const res = await t.run("scholar_fetch_pdf", { id: "1706.03762" });
    expect(res.text).toMatch(/^Error: .*did not return a PDF/);
    const work = JSON.parse(fixture("openalex-search.json")).results[0];
    const internal = {
      ...work,
      best_oa_location: { ...work.best_oa_location, pdf_url: "http://127.0.0.1:8080/secret.pdf" },
    };
    const t2 = pdfTools(
      [(u) => (u.hostname === "api.openalex.org" ? json(internal) : null)],
      () => new Response(PDF),
    );
    const r2 = await t2.run("scholar_fetch_pdf", { id: "10.3390/make7030089" });
    expect(r2.text).toMatch(/^Error: .*not a public host/);
    expect(t2.downloads).toHaveLength(0);
  });
});

describe("scholar_grant_deadlines", () => {
  it("reminders at fixed distances, each with a stable id; past and far deadlines skipped", () => {
    const list = parseDeadlines(fs.readFileSync(path.join(folder, "knowledge/grants.md"), "utf8"));
    expect(list.map((d) => d.name)).toEqual([
      "KAKENHI Grant-in-Aid (C)",
      "JST ACT-X",
      "学内研究費",
      "past call",
      "far away",
    ]);
    const due = dueReminders(list, "2026-10-25");
    expect(due.map((r) => [r.name, r.daysLeft, r.bucket])).toEqual([
      ["学内研究費", 0, 0],
      ["JST ACT-X", 3, 3],
      ["KAKENHI Grant-in-Aid (C)", 11, 14],
    ]);
    expect(due[2].id).toBe("grant:kakenhi-grant-in-aid-c:2026-11-05:d14");
    expect(due[0].id).toMatch(/^grant:[0-9a-f]{10}:2026-10-25:d0$/);
  });

  it("the tool lists today's reminders and returns one by id", async () => {
    const t = makeTools(recorded, {
      ctx: { agentId: "main", sessionKey },
      extra: { now: () => new Date("2026-10-25T00:30:00Z") },
    });
    const all = await t.run("scholar_grant_deadlines", { path: "knowledge/grants.md" });
    expect(all.details.count).toBe(3);
    expect(all.text).toContain("today 2026-10-25, Asia/Tokyo");
    const id = (all.details.ids as string[])[2];
    const one = await t.run("scholar_grant_deadlines", { path: "knowledge/grants.md", id });
    expect(one.details).toMatchObject({ count: 1, ids: [id] });
    expect(one.text).toContain("1. id: grant:kakenhi-grant-in-aid-c:2026-11-05:d14");
    expect(one.text).toContain("11 day(s) left");
    expect(t.calls).toHaveLength(0);
  });
});
