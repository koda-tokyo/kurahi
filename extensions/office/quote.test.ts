import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoPluginAuditInput } from "../../src/plugins/types.js";
import { extractText } from "../../src/projects/documents.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import { testWorkbook } from "../../src/quotes/test-helpers.js";
import { createOfficeTools } from "./index.js";
import { parseQuoteRequest, readCompany } from "./src/quote.js";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-quote-test-")));
const home = path.join(tmpRoot, "state");
fs.mkdirSync(home, { recursive: true });
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const NOW = new Date("2026-10-25T09:00:00Z");
const PRICE_LIST = [
  "品番,品名,単位,単価,税率",
  "A-100,部品A,個,1200,10%",
  "S-900,設置作業,時間,8000,10",
  "F-001,弁当,個,1080,8",
].join("\r\n");

let seq = 0;
function setup(opts: { list?: string | Buffer; company?: unknown; mode?: "act" | "read" } = {}) {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  for (const sub of ["output", "quotes"]) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
  }
  if (opts.list !== undefined) {
    fs.writeFileSync(path.join(folder, "quotes", "price-list.csv"), opts.list);
  }
  if (opts.company !== undefined) {
    fs.writeFileSync(path.join(folder, "quotes", "company.json"), JSON.stringify(opts.company));
  }
  const project = createProject(
    {
      name: `Quotes ${seq}`,
      folder,
      rules: {
        readOnly: [],
        writable: ["output"],
        artifactApprovalRequired: false,
        instructions: [],
      },
      mode: opts.mode ?? "act",
    },
    { createdBy: "owner", home },
  );
  const audits: KoLoPluginAuditInput[] = [];
  const tools = createOfficeTools({
    agentId: "main",
    sessionKey: projectSessionKey("main", project.id, "c1"),
    audit: (a) => audits.push(a),
    home,
    now: () => NOW,
  });
  const t = tools.find((x) => x.name === "office_quote_create") as unknown as {
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  };
  return { folder, audits, quote: (q: unknown) => t.execute("call-1", { quote: q }) };
}

const REQUEST = {
  customer: "株式会社サンプル精機",
  subject: "部品と設置作業の御見積",
  lines: [
    { code: "A-100", description: "部品A", quantity: 10 },
    { description: "設置作業", quantity: 1.5 },
    { description: "弁当", quantity: 3 },
  ],
  payment_terms: "月末締め翌月末払い",
};

describe("office_quote_create", () => {
  it("prices from the list, computes tax per rate and writes Word and Excel", async () => {
    const env = setup({
      list: PRICE_LIST,
      company: { name: "株式会社ミナト商会", registrationNumber: "T1234567890123" },
    });
    const r = await env.quote(REQUEST);
    expect(r.details).toMatchObject({
      number: "Q-20261025",
      lines: 3,
      unpriced: 0,
      // 12,000 + 12,000 at 10% (2,400) and 3,240 at 8% (259.2 → 259)
      subtotal: 27240,
      tax: 2659,
      total: 29899,
      validUntil: "2026-11-24",
      path: "output/quotes/見積書_Q-20261025.docx",
      workbook: "output/quotes/見積書_Q-20261025.xlsx",
    });
    const docx = fs.readFileSync(path.join(env.folder, String(r.details?.path)));
    const text = await extractText("docx", docx);
    expect(text).toContain("御見積書");
    expect(text).toContain("株式会社サンプル精機 御中");
    expect(text).toContain("消費税（8%）");
    expect(text).toContain("¥29,899");
    expect(text).toContain("T1234567890123");
    expect(text).not.toContain("暫定");
    expect(text).toMatch(/quotes\/price-list\.csv · sha256 [0-9a-f]{12}/);
    const xlsx = await extractText(
      "xlsx",
      fs.readFileSync(path.join(env.folder, String(r.details?.workbook))),
    );
    expect(xlsx).toContain("部品A");
    expect(xlsx).toContain("29899");
    expect(env.audits.at(-1)).toMatchObject({ action: "office.quote.create", outcome: "ok" });
    // Audit rows carry counts, never customer names or amounts.
    expect(JSON.stringify(env.audits)).not.toContain("サンプル精機");
  });

  it("marks lines the price list cannot match as 要確認 and leaves them out of the totals", async () => {
    const env = setup({ list: PRICE_LIST });
    const r = await env.quote({
      ...REQUEST,
      lines: [
        { code: "A-100", description: "部品A", quantity: 1 },
        { code: "Z-999", description: "特注品", quantity: 2 },
      ],
    });
    expect(r.details).toMatchObject({ lines: 1, unpriced: 1, subtotal: 1200, total: 1320 });
    expect(String(r.details?.priceListSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(r.content[0].text).toContain("need a price from a person");
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(env.folder, String(r.details?.path))),
    );
    expect(text).toContain("【要確認】価格未設定の品目");
    expect(text).toContain("御見積書（暫定）");
    expect(text).toContain("暫定合計—未確定項目あり");
    expect(text).toContain("特注品");
  });

  it("names a person with 様, prints the issuer's department and contact, and hashes both files", async () => {
    const env = setup({
      list: PRICE_LIST,
      company: { name: "株式会社ミナト商会", department: "営業部", contact: "山田 太郎" },
    });
    const r = await env.quote({ ...REQUEST, attention: "佐藤 一郎" });
    const docx = fs.readFileSync(path.join(env.folder, String(r.details?.path)));
    const text = await extractText("docx", docx);
    expect(text).toContain("株式会社サンプル精機");
    expect(text).toContain("佐藤 一郎 様");
    expect(text).not.toContain("御中");
    expect(text).toContain("営業部");
    expect(text).toContain("山田 太郎");
    const crypto = await import("node:crypto");
    expect(r.details?.documentSha256).toBe(crypto.createHash("sha256").update(docx).digest("hex"));
    expect(String(r.details?.workbookSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(r.details).toMatchObject({ provisional: false, zeroRateLines: 0 });
  });

  it("makes a quotation with a 0% line provisional until tax classifications are supported", async () => {
    const env = setup({ list: `${PRICE_LIST}\r\nE-001,輸出向け部品,個,5000,0` });
    const r = await env.quote({
      ...REQUEST,
      lines: [{ code: "E-001", description: "輸出向け部品", quantity: 2 }],
    });
    expect(r.details).toMatchObject({
      provisional: true,
      zeroRateLines: 1,
      unpriced: 0,
      total: 10000,
    });
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(env.folder, String(r.details?.path))),
    );
    expect(text).toContain("御見積書（暫定）");
    expect(text).toContain("非課税・不課税・輸出免税");
  });

  it("prints items a person took out of scope with the reason, and is then final", async () => {
    const env = setup({ list: PRICE_LIST });
    const r = await env.quote({
      ...REQUEST,
      lines: [{ code: "A-100", description: "部品A", quantity: 1 }],
      excluded: [
        { description: "特注品", quantity: 1, reason: "特注品は仕様確定後に別見積とする" },
      ],
    });
    expect(r.details).toMatchObject({ unpriced: 0, excluded: 1, provisional: false, total: 1320 });
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(env.folder, String(r.details?.path))),
    );
    expect(text).toContain("対象外の品目");
    expect(text).toContain("特注品は仕様確定後に別見積とする");
    expect(text).not.toContain("暫定");
    const short = await env.quote({
      ...REQUEST,
      excluded: [{ description: "x", reason: "too short" }],
    });
    expect(short.content[0].text).toMatch(/why the item is out of scope/);
    const both = await env.quote({
      ...REQUEST,
      lines: [{ code: "A-100", description: "部品A", quantity: 1 }],
      excluded: [{ code: "a-100", description: "部品A", reason: "お客様支給品のため対象外とする" }],
    });
    expect(both.content[0].text).toMatch(/either quoted or out of scope/);
    const byName = await env.quote({
      ...REQUEST,
      lines: [{ description: "部品A", quantity: 1 }],
      excluded: [{ description: " 部品A ", reason: "お客様支給品のため対象外とする" }],
    });
    expect(byName.content[0].text).toMatch(/either quoted or out of scope/);
  });

  it("numbers a revision and names the version it supersedes", async () => {
    const env = setup({ list: PRICE_LIST });
    // Nothing to supersede yet: Q-20261025 was never written here.
    const orphan = await env.quote({ ...REQUEST, number: "Q-20261025", revision: 2 });
    expect(orphan.content[0].text).toMatch(/no quotation Q-20261025 in output\/quotes/);
    await env.quote({ ...REQUEST, number: "Q-20261025" });
    // R3 supersedes R2, which does not exist yet.
    const skipped = await env.quote({ ...REQUEST, number: "Q-20261025", revision: 3 });
    expect(skipped.content[0].text).toMatch(/no quotation Q-20261025-R2/);
    const r2 = await env.quote({ ...REQUEST, number: "Q-20261025", revision: 2 });
    expect(r2.details).toMatchObject({
      number: "Q-20261025-R2",
      revision: 2,
      supersedes: "Q-20261025",
    });
    const r3 = await env.quote({ ...REQUEST, number: "Q-20261025", revision: 3 });
    expect(r3.details).toMatchObject({ number: "Q-20261025-R3", supersedes: "Q-20261025-R2" });
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(env.folder, String(r3.details?.path))),
    );
    expect(text).toContain("改訂");
    expect(text).toContain("Q-20261025-R2");
    const noNumber = await env.quote({ ...REQUEST, revision: 2 });
    expect(noNumber.content[0].text).toMatch(/a revision needs quote.number/);
    // The original number, not an earlier revision's: never Q-…-R2-R3.
    const stacked = await env.quote({ ...REQUEST, number: "Q-20261025-R2", revision: 3 });
    expect(stacked.content[0].text).toMatch(/original number, without -R/);
  });

  it("never overwrites an earlier quotation", async () => {
    const env = setup({ list: PRICE_LIST });
    const a = await env.quote(REQUEST);
    const b = await env.quote(REQUEST);
    expect(b.details?.path).toBe("output/quotes/見積書_Q-20261025-2.docx");
    expect(a.details?.path).not.toBe(b.details?.path);
  });

  it("reads a Shift_JIS price list", async () => {
    // "品番,品名,単価\nA,部品,100" in Shift_JIS
    const sjis = Buffer.from(
      "9569 94d4 2c 9569 96bc 2c 92 50 89 bf 0a 41 2c 95 94 95 69 2c 31 30 30".replace(/\s/g, ""),
      "hex",
    );
    const env = setup({ list: sjis });
    const r = await env.quote({
      customer: "c",
      subject: "s",
      lines: [{ code: "A", description: "x", quantity: 2 }],
    });
    expect(r.details).toMatchObject({ lines: 1, subtotal: 200, total: 220 });
  });

  it("reads an Excel price list", async () => {
    const env = setup();
    const t = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    fs.writeFileSync(
      path.join(env.folder, "quotes", "price-list.xlsx"),
      await testWorkbook([
        {
          name: "価格表",
          xml:
            `<row r="1">${t("A1", "品番")}${t("B1", "品名")}${t("C1", "単価")}${t("D1", "税率")}</row>` +
            `<row r="2">${t("A2", "A-100")}${t("B2", "部品A")}<c r="C2"><v>1200</v></c><c r="D2"><v>0.1</v></c></row>` +
            `<row r="3">${t("A3", "F-001")}${t("B3", "弁当")}<c r="C3"><v>1080</v></c><c r="D3"><v>0.08</v></c></row>`,
        },
      ]),
    );
    const r = await env.quote({
      ...REQUEST,
      lines: [
        { code: "A-100", description: "部品A", quantity: 2 },
        { description: "弁当", quantity: 1 },
      ],
      price_list: "quotes/price-list.xlsx",
    });
    expect(r.details).toMatchObject({ lines: 2, unpriced: 0, subtotal: 3480 });
    expect(r.content[0].text).not.toMatch(/rows? with problems/);
    expect(String(r.details?.priceListSha256)).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(env.folder, "quotes", "csv.xlsx"), PRICE_LIST);
    const notXlsx = await env.quote({ ...REQUEST, price_list: "quotes/csv.xlsx" });
    expect(notXlsx.content[0].text).toMatch(
      /price list quotes\/csv.xlsx: the workbook cannot be read/,
    );
  });

  it("flags a price list unchanged for longer than the company's limit, without blocking", async () => {
    const env = setup({ list: PRICE_LIST });
    const list = path.join(env.folder, "quotes", "price-list.csv");
    const at = (iso: string) => fs.utimesSync(list, new Date(iso), new Date(iso));
    // NOW is 2026-10-25 in Japan; 180 days earlier is 2026-04-28.
    at("2026-04-28T03:00:00Z");
    const edge = await env.quote(REQUEST);
    expect(edge.details).toMatchObject({
      priceListUpdated: "2026-04-28",
      priceListAgeDays: 180,
      priceListMaxAgeDays: 180,
      priceListOverdueDays: 0,
      priceListStale: false,
      provisional: false,
    });
    expect(edge.content[0].text).not.toContain("価格表の更新日");
    at("2026-04-27T03:00:00Z");
    const stale = await env.quote(REQUEST);
    expect(stale.details).toMatchObject({
      priceListAgeDays: 181,
      priceListOverdueDays: 1,
      priceListStale: true,
      provisional: false,
      subtotal: 27240,
    });
    expect(stale.content[0].text).toContain("last changed 2026-04-27 (181 days ago)");
    // A file dated after the issue date (clock skew) is age 0, never negative.
    at("2026-11-01T00:00:00Z");
    expect((await env.quote(REQUEST)).details).toMatchObject({
      priceListAgeDays: 0,
      priceListStale: false,
    });
    // The company's own limit applies.
    fs.writeFileSync(
      path.join(env.folder, "quotes", "company.json"),
      JSON.stringify({ priceListMaxAgeDays: 30 }),
    );
    at("2026-09-24T03:00:00Z");
    expect((await env.quote(REQUEST)).details).toMatchObject({
      priceListAgeDays: 31,
      priceListMaxAgeDays: 30,
      priceListOverdueDays: 1,
      priceListStale: true,
    });
  });

  it("refuses without a price list, outside 実行 mode, or with prices in the request", async () => {
    expect((await setup().quote(REQUEST)).content[0].text).toMatch(
      /price list quotes\/price-list.csv/,
    );
    expect((await setup({ list: PRICE_LIST, mode: "read" }).quote(REQUEST)).details?.error).toBe(
      "mode",
    );
    const priced = await setup({ list: PRICE_LIST }).quote({
      ...REQUEST,
      lines: [{ description: "部品A", quantity: 1, unit_price: 1 }],
    });
    expect(priced.content[0].text).toContain("prices come from the price list");
  });

  it("prices only from a list under quotes/, never one the agent can write", async () => {
    const s = setup({ list: PRICE_LIST });
    fs.writeFileSync(path.join(s.folder, "output", "custom.csv"), "code,name,price\nA-100,部品A,1");
    for (const price_list of [
      "output/custom.csv",
      "./output/custom.csv",
      "quotes/../output/custom.csv",
      "plans/x.csv",
      "quotes/company.json",
      "quotes/price-list.xlsm",
    ]) {
      const r = await s.quote({ ...REQUEST, price_list });
      expect(r.content[0].text).toMatch(/price list .*(under quotes\/|can write)/);
    }
    fs.symlinkSync(
      path.join(s.folder, "output", "custom.csv"),
      path.join(s.folder, "quotes", "link.csv"),
    );
    const linked = await s.quote({ ...REQUEST, price_list: "quotes/link.csv" });
    expect(linked.content[0].text).toMatch(/price list quotes\/link.csv/);
    expect(linked.details).not.toMatchObject({ subtotal: expect.anything() });
    expect(
      (await s.quote({ ...REQUEST, price_list: "quotes/price-list.csv" })).details,
    ).toHaveProperty("subtotal");
  });
});

describe("parseQuoteRequest", () => {
  it("validates the request", () => {
    expect(() =>
      parseQuoteRequest({ subject: "s", lines: [{ description: "x", quantity: 1 }] }),
    ).toThrow("customer");
    expect(() => parseQuoteRequest({ customer: "c", subject: "s", lines: [] })).toThrow(
      "at least one line",
    );
    expect(() =>
      parseQuoteRequest({
        customer: "c",
        subject: "s",
        lines: [{ description: "x", quantity: 1 }],
        validity_days: 0,
      }),
    ).toThrow("validity_days");
    expect(() =>
      parseQuoteRequest({
        customer: "c",
        subject: "s",
        lines: [{ description: "x", quantity: 1 }],
        number: "../x",
      }),
    ).toThrow("quote.number");
    const r = parseQuoteRequest({
      customer: "c",
      subject: "s",
      lines: [{ code: "A", quantity: "2" }],
      language: "en",
    });
    expect(r).toMatchObject({
      honorific: "",
      lang: "en",
      validityDays: 30,
      lines: [{ code: "A", description: "A" }],
    });
  });

  it("refuses an over-long code or registration number instead of shortening it", () => {
    expect(() =>
      parseQuoteRequest({
        customer: "c",
        subject: "s",
        lines: [{ code: "A".repeat(64) + "Z", quantity: 1 }],
      }),
    ).toThrow("longer than 64");
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quote-company-"));
    fs.mkdirSync(path.join(folder, "quotes"));
    fs.writeFileSync(
      path.join(folder, "quotes", "company.json"),
      JSON.stringify({ registrationNumber: "T12345678901234" }),
    );
    try {
      expect(() => readCompany({ folder } as Parameters<typeof readCompany>[0])).toThrow(
        "registrationNumber",
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a price list age limit that is not a whole number of days from 1 to 3650", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quote-company-"));
    fs.mkdirSync(path.join(folder, "quotes"));
    const read = (priceListMaxAgeDays: unknown) => {
      fs.writeFileSync(
        path.join(folder, "quotes", "company.json"),
        JSON.stringify({ priceListMaxAgeDays }),
      );
      return readCompany({ folder } as Parameters<typeof readCompany>[0]);
    };
    try {
      for (const bad of [0, -1, 3651, 1.5, "180"]) {
        expect(() => read(bad)).toThrow("priceListMaxAgeDays");
      }
      expect(read(1)).toEqual({ priceListMaxAgeDays: 1 });
      expect(read(3650)).toEqual({ priceListMaxAgeDays: 3650 });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
