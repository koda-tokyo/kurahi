// The autopilot action catalogue: every action a routine may name, with its classification.
// authorizeAction() decides on the classification, never on the name, so an edition or a plugin
// adds actions by registering them here with a declared class. A registration can never weaken
// an existing one (same id, less strict class), and `never` actions are executed by nobody.

import type { ActionClass, Edition } from "./types.js";
import { OFFICE_TOOL_OF, officeArgsError } from "./office-spec.js";
import { ACTION_CLASSES, EDITIONS } from "./types.js";

/** Arguments an action accepts (anything else is refused). */
export type ArgKind = "string" | "string[]" | "number" | "boolean" | "object";
/** `max`: characters (string), entries (string[]) or JSON bytes (object). */
export type ArgSpec = { kind: ArgKind; required?: boolean; max?: number };

/**
 * How the engine executes an allowed action:
 * - `tool`: through the gateway tool path, with one of `tools` (the routine picks with
 *   actionTools; the first is the default);
 * - `workitem` / `proposal`: built into the engine (work item intake, a calendar proposal
 *   recorded as a work item);
 * - `office`: an Office file through the office plugin's tool for the spec's kind
 *   (office-spec.ts), written under the Project's output/;
 * - `brief`: the morning brief (brief.ts), drafted in Outlook to the person's own address or
 *   written to output/briefs/ (never sent);
 * - `none`: no executor on this gateway (an allowed action then waits for a person).
 */
export type ActionExecutorKind = "tool" | "workitem" | "proposal" | "office" | "brief" | "none";

export type ActionTargets = { recipients: string[]; targets: string[]; templateId: string | null };

export type ActionDef = {
  id: string;
  class: ActionClass;
  /** Editions whose routines may name the action. */
  editions: readonly Edition[];
  label: { ja: string; en: string };
  executor: ActionExecutorKind;
  tools: readonly string[];
  args: Record<string, ArgSpec>;
  /** Who and what an external action reaches (checked against the standing approval). */
  targetsOf?: (args: Record<string, unknown>) => ActionTargets;
  /** Extra argument check after the per-argument specs (an error message, or null). */
  validate?: (args: Record<string, unknown>) => string | null;
  /** Registering plugin id, or `core`. */
  source: string;
  /**
   * `tool` executor: the tool's `details.path` is a Project-relative file it wrote; the item's
   * work item references it as a source document.
   */
  producesFile?: boolean;
  /**
   * Runs only once the item's work item is filed (after workitem.intake, which the engine
   * executes last): never when filing failed, so nothing it records is lost before a person
   * has the item.
   */
  afterIntake?: boolean;
  /**
   * `tool` executor with producesFile: the file is the item's document, so a later mail.attach
   * attaches it to the item's reply draft (as office.create's file is).
   */
  attachable?: boolean;
  /**
   * `tool` executor: work item fields taken from the tool's details (numbers and short strings
   * the engine copies, never model text), so the Project's checks can see them.
   */
  fieldsOf?: (details: Record<string, unknown>) => Record<string, string | number>;
};

const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ALL = EDITIONS;
const RANK: Record<ActionClass, number> = {
  prepare: 0,
  "internal-reversible": 1,
  external: 2,
  never: 3,
};

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function mailTargets(args: Record<string, unknown>): ActionTargets {
  return {
    recipients: [...strs(args.to), ...strs(args.cc), ...strs(args.bcc)].map((a) =>
      a.trim().toLowerCase(),
    ),
    targets: [],
    templateId: typeof args.templateId === "string" ? args.templateId : null,
  };
}

const MAIL_ARGS: Record<string, ArgSpec> = {
  to: { kind: "string[]", required: true, max: 20 },
  cc: { kind: "string[]", max: 20 },
  subject: { kind: "string", required: true, max: 255 },
  body: { kind: "string", required: true, max: 16_000 },
  replyToMessageId: { kind: "string", max: 512 },
  templateId: { kind: "string", max: 64 },
};

function never(id: string, editions: readonly Edition[], en: string, ja: string): ActionDef {
  return {
    id,
    class: "never",
    editions,
    label: { en, ja },
    executor: "none",
    tools: [],
    args: {},
    source: "core",
  };
}

const CORE: ActionDef[] = [
  {
    id: "workitem.intake",
    class: "prepare",
    editions: ALL,
    label: { en: "Create a work item", ja: "案件を起票" },
    executor: "workitem",
    tools: [],
    args: {
      title: { kind: "string", max: 200 },
      type: { kind: "string", max: 32 },
      priority: { kind: "string", max: 16 },
      note: { kind: "string", max: 4000 },
      // Business: the department whose queue (<department>-work) takes the item, when the
      // Project has that queue; otherwise the routine's queue.
      department: { kind: "string", max: 32 },
    },
    source: "core",
  },
  {
    id: "mail.draft",
    class: "prepare",
    editions: ALL,
    label: { en: "Prepare a reply draft", ja: "返信の下書きを作成" },
    executor: "tool",
    tools: ["m365_mail_create_draft"],
    args: MAIL_ARGS,
    source: "core",
  },
  {
    id: "mail.attach",
    class: "prepare",
    editions: ALL,
    label: { en: "Attach the prepared document to the reply draft", ja: "下書きに作成文書を添付" },
    // A declared sequence within one item: the draft and the document are the ones this item's
    // earlier mail.draft and office.create produced (the engine binds them; the model names
    // neither, so it can never point at another draft or another file).
    executor: "tool",
    tools: ["m365_mail_attach_to_draft"],
    args: {},
    source: "core",
  },
  {
    id: "office.create",
    class: "prepare",
    editions: ALL,
    label: { en: "Prepare an Office document", ja: "Office文書を作成" },
    // The office plugin's renderers, through its tools, into output/<file> (office-spec.ts).
    executor: "office",
    tools: [OFFICE_TOOL_OF.docx, OFFICE_TOOL_OF.pptx, OFFICE_TOOL_OF.xlsx],
    args: {
      kind: { kind: "string", required: true, max: 8 },
      file: { kind: "string", required: true, max: 84 },
      spec: { kind: "object", required: true, max: 400_000 },
    },
    validate: officeArgsError,
    source: "core",
  },
  {
    id: "quote.prepare",
    class: "prepare",
    editions: ["business"],
    label: { en: "Prepare a quotation", ja: "見積書を作成" },
    // The office plugin's quotation tool: the model gives the customer, subject and requested
    // lines (code or name, quantity); prices, tax and totals come from the Project's price list
    // and src/quotes, never from the model. Lines the list cannot price are marked 要確認.
    executor: "tool",
    tools: ["office_quote_create"],
    args: { quote: { kind: "object", required: true, max: 60_000 } },
    validate: (args) => {
      const q = args.quote as Record<string, unknown>;
      const lines = Array.isArray(q.lines) ? q.lines : [];
      if (lines.length === 0) {
        return "quote.lines needs at least one line";
      }
      // Scope and revisions are a person's decisions, never a routine's.
      if ("excluded" in q || "revision" in q) {
        return "a routine cannot take items out of scope or revise a quotation; a person does that";
      }
      return lines.some(
        (l) =>
          l &&
          typeof l === "object" &&
          ["unit_price", "unitPrice", "price", "amount"].some((k) => k in l),
      )
        ? "quote lines carry no prices: prices come from the price list"
        : null;
    },
    producesFile: true,
    attachable: true,
    // The quotation's computed figures, for checks such as "no unpriced lines" and amount routing.
    fieldsOf: (d) => {
      const out: Record<string, string | number> = {};
      for (const [from, to] of [
        ["number", "quoteNumber"],
        ["subtotal", "quoteSubtotal"],
        ["tax", "quoteTax"],
        ["total", "quoteTotal"],
        ["unpriced", "quoteUnpriced"],
        ["lines", "quoteLines"],
        ["validUntil", "quoteValidUntil"],
        ["priceListSha256", "quotePriceList"],
        ["priceListAgeDays", "quotePriceListAgeDays"],
        ["priceListMaxAgeDays", "quotePriceListMaxAgeDays"],
        ["priceListOverdueDays", "quotePriceListOverdueDays"],
        ["documentSha256", "quoteDocument"],
        ["workbookSha256", "quoteWorkbook"],
        ["zeroRateLines", "quoteZeroRate"],
        ["revision", "quoteRevision"],
        ["supersedes", "quoteSupersedes"],
        ["excluded", "quoteExcluded"],
      ] as const) {
        const v = d[from];
        if (typeof v === "number" && Number.isSafeInteger(v)) {
          out[to] = v;
        } else if (typeof v === "string" && v.length <= 80) {
          out[to] = v;
        }
      }
      return out;
    },
    source: "office",
  },
  {
    id: "po.prepare",
    class: "prepare",
    editions: ["business"],
    label: { en: "Draft a purchase order", ja: "発注書（下書き）を作成" },
    // The office plugin's purchase order tool, for a procurement case a person already chose a
    // supplier on (workitems.selectSupplier). The model names the case; the engine binds the
    // comparison, supplier, chooser and reason from the case (purchase-order.ts), so they are
    // not arguments here and are refused if given. The draft is never issued or sent.
    executor: "tool",
    tools: ["office_po_create"],
    args: {
      case: { kind: "string", required: true, max: 64 },
      number: { kind: "string", max: 40 },
      delivery: { kind: "string", max: 200 },
      notes: { kind: "string", max: 2000 },
      language: { kind: "string", max: 2 },
    },
    producesFile: true,
    fieldsOf: (d) => {
      const out: Record<string, string | number> = {};
      for (const [from, to] of [
        ["number", "poNumber"],
        ["supplier", "poSupplier"],
        ["net", "poNet"],
        ["tax", "poTax"],
        ["total", "poTotal"],
        ["documentSha256", "poDocument"],
        ["workbookSha256", "poWorkbook"],
      ] as const) {
        const v = d[from];
        if (typeof v === "number" && Number.isSafeInteger(v)) {
          out[to] = v;
        } else if (typeof v === "string" && v.length <= 80) {
          out[to] = v;
        }
      }
      return out;
    },
    source: "office",
  },
  {
    id: "files.upload",
    class: "prepare",
    editions: ALL,
    label: { en: "Upload to the app folder", ja: "アプリ用フォルダーへアップロード" },
    executor: "tool",
    // m365_files_upload writes only to the signed-in user's OneDrive app folder.
    tools: ["m365_files_upload"],
    args: { path: { kind: "string", required: true, max: 512 } },
    source: "core",
  },
  {
    id: "calendar.propose",
    class: "prepare",
    editions: ALL,
    label: { en: "Propose meeting times", ja: "日程候補を提案" },
    // A proposal is recorded for a person; nothing is written to a calendar.
    executor: "proposal",
    tools: [],
    args: {
      title: { kind: "string", required: true, max: 200 },
      slots: { kind: "string[]", required: true, max: 10 },
      attendees: { kind: "string[]", max: 20 },
      note: { kind: "string", max: 2000 },
    },
    source: "core",
  },
  {
    id: "brief.deliver",
    class: "prepare",
    editions: ALL,
    label: {
      en: "Prepare a morning brief (draft or file)",
      ja: "朝のブリーフを作成（下書き・ファイル）",
    },
    // brief.ts: the brief of one Project member, built from recorded data, as an Outlook DRAFT
    // to that member's own address (work queue policy) or a file in output/briefs/. The
    // recipient comes from the policy, never from the plan; nothing is sent.
    executor: "brief",
    tools: ["m365_mail_create_draft"],
    args: { principal: { kind: "string", required: true, max: 200 } },
    source: "core",
  },
  {
    id: "mail.send",
    class: "external",
    editions: ALL,
    label: { en: "Send a routine message", ja: "定型メールを送信" },
    executor: "tool",
    tools: ["m365_mail_send", "gmail_send"],
    args: MAIL_ARGS,
    targetsOf: mailTargets,
    source: "core",
  },
  // Industrial: the legacy-analyzer extension's read-only analysis and its 設計書.
  {
    id: "legacy.analyze",
    class: "prepare",
    editions: ["industrial"],
    label: { en: "Run the legacy analysis", ja: "レガシー解析を実行" },
    executor: "tool",
    tools: ["legacy_index"],
    args: { path: { kind: "string", required: true, max: 512 } },
    source: "legacy-analyzer",
  },
  {
    id: "legacy.design_doc",
    class: "prepare",
    editions: ["industrial"],
    label: { en: "Regenerate the design document", ja: "設計書を再生成" },
    executor: "tool",
    tools: ["legacy_design_doc"],
    args: {
      path: { kind: "string", required: true, max: 512 },
      lang: { kind: "string", max: 4 },
      section: { kind: "string", max: 200 },
      program: { kind: "string", max: 128 },
      // docx: also a Word file in output/design-docs/ (the work item references it).
      output_format: { kind: "string", max: 4 },
    },
    validate: (args) =>
      args.output_format === undefined ||
      args.output_format === "md" ||
      args.output_format === "docx"
        ? null
        : 'output_format must be "md" or "docx"',
    producesFile: true,
    source: "legacy-analyzer",
  },
  {
    id: "legacy.baseline_advance",
    class: "prepare",
    editions: ["industrial"],
    label: { en: "Advance the change baseline", ja: "変更検知の基準を更新" },
    // The analyser cache only: the baseline moves to the snapshot this run's legacy_changes
    // compared, after the item listing those changes is filed.
    executor: "tool",
    tools: ["legacy_baseline_advance"],
    args: {
      path: { kind: "string", required: true, max: 512 },
      snapshot: { kind: "string", max: 16 },
    },
    validate: (args) =>
      args.snapshot === undefined ||
      (typeof args.snapshot === "string" && /^[a-f0-9]{16}$/.test(args.snapshot))
        ? null
        : "snapshot must be the 16-hex digest legacy_changes reported",
    afterIntake: true,
    source: "legacy-analyzer",
  },
  {
    id: "repo.open_pr",
    class: "external",
    editions: ["industrial", "core"],
    label: { en: "Open a pull request", ja: "プルリクエストを作成" },
    executor: "none",
    tools: [],
    args: {
      repo: { kind: "string", required: true, max: 200 },
      title: { kind: "string", required: true, max: 200 },
      body: { kind: "string", max: 16_000 },
    },
    targetsOf: (args) => ({
      recipients: [],
      targets: typeof args.repo === "string" ? [args.repo.trim().toLowerCase()] : [],
      templateId: null,
    }),
    source: "core",
  },
  // Scholars.
  {
    id: "research.search",
    class: "prepare",
    editions: ["scholars"],
    label: { en: "Search the literature", ja: "文献を検索" },
    executor: "tool",
    tools: ["web_search"],
    args: { query: { kind: "string", required: true, max: 400 }, count: { kind: "number" } },
    source: "core",
  },
  // Never autonomous, whatever the level: a person decides (prepared to 99%, one click).
  never("payment.execute", ALL, "Execute a payment", "支払を実行"),
  never("bank.change", ALL, "Change bank details", "口座情報を変更"),
  never("contract.sign", ALL, "Sign a contract", "契約に署名"),
  never("hr.decision", ALL, "Decide about a person (HR, legal)", "人事・法務上の判断"),
  never("ot.write", ["industrial"], "Write to production OT", "本番OTへ書き込み"),
  never("plc.write", ["industrial"], "Write to a PLC", "PLCへ書き込み"),
  never(
    "repo.merge",
    ["industrial", "core"],
    "Merge into a customer system",
    "顧客システムへマージ",
  ),
  never("deploy", ["industrial", "core"], "Deploy to a customer system", "顧客システムへデプロイ"),
  never("journal.submit", ["scholars"], "Submit a paper", "論文を投稿"),
  never("grant.submit", ["scholars"], "Submit a grant application", "助成金を申請"),
  never("participant.contact", ["scholars"], "Contact research participants", "研究参加者へ連絡"),
  never("secrets.change", ALL, "Change secrets or access", "秘密情報・権限を変更"),
  never("data.delete", ALL, "Delete data", "データを削除"),
];

const registry = new Map<string, ActionDef>(CORE.map((d) => [d.id, d]));

/**
 * Register an action (an edition pack or a plugin). Refused when the id is malformed, the class
 * unknown, or the id already exists with a less strict class: a registration can only keep or
 * tighten what is there, never loosen it.
 */
export function registerAutopilotAction(def: ActionDef): void {
  if (!ID_RE.test(def.id) || def.id.length > 64) {
    throw new Error(`autopilot action id ${def.id} must be lowercase dotted words (area.verb)`);
  }
  if (!(ACTION_CLASSES as readonly string[]).includes(def.class)) {
    throw new Error(`autopilot action ${def.id}: unknown class ${String(def.class)}`);
  }
  if (def.class === "external" && !def.targetsOf) {
    throw new Error(`autopilot action ${def.id}: an external action must declare targetsOf`);
  }
  const prior = registry.get(def.id);
  if (prior && RANK[def.class] < RANK[prior.class]) {
    throw new Error(
      `autopilot action ${def.id} is ${prior.class}; it cannot be re-registered as ${def.class}`,
    );
  }
  registry.set(def.id, {
    ...def,
    // A never action has no executor, whoever registers it.
    executor: def.class === "never" ? "none" : def.executor,
    tools: def.class === "never" ? [] : def.tools,
  });
}

export function getActionDef(id: string): ActionDef | null {
  return registry.get(id) ?? null;
}

export function listActionDefs(): ActionDef[] {
  return [...registry.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Tests: drop registrations that are not core. */
export function resetAutopilotActionsForTests(): void {
  registry.clear();
  for (const d of CORE) {
    registry.set(d.id, d);
  }
}

/** Validate and clean the arguments of one proposed action. Returns an error message or args. */
export function cleanActionArgs(
  def: ActionDef,
  raw: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in def.args)) {
      return { ok: false, error: `argument ${key} is not accepted by ${def.id}` };
    }
  }
  for (const [key, spec] of Object.entries(def.args)) {
    const v = raw[key];
    if (v === undefined || v === null) {
      if (spec.required) {
        return { ok: false, error: `argument ${key} is required` };
      }
      continue;
    }
    switch (spec.kind) {
      case "string":
        if (typeof v !== "string") {
          return { ok: false, error: `argument ${key} must be a string` };
        }
        if (spec.max && v.length > spec.max) {
          return { ok: false, error: `argument ${key} is longer than ${spec.max}` };
        }
        out[key] = v;
        break;
      case "string[]":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          return { ok: false, error: `argument ${key} must be a list of strings` };
        }
        if (spec.max && v.length > spec.max) {
          return { ok: false, error: `argument ${key} has more than ${spec.max} entries` };
        }
        if (spec.required && v.length === 0) {
          return { ok: false, error: `argument ${key} is required` };
        }
        out[key] = v.map((x: string) => x.slice(0, 512));
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return { ok: false, error: `argument ${key} must be a number` };
        }
        out[key] = v;
        break;
      case "boolean":
        if (typeof v !== "boolean") {
          return { ok: false, error: `argument ${key} must be true or false` };
        }
        out[key] = v;
        break;
      case "object": {
        if (typeof v !== "object" || Array.isArray(v)) {
          return { ok: false, error: `argument ${key} must be an object` };
        }
        const json = JSON.stringify(v);
        if (spec.max && Buffer.byteLength(json, "utf8") > spec.max) {
          return { ok: false, error: `argument ${key} is larger than ${spec.max} bytes` };
        }
        // A plain-data copy: nothing the model sent can be a shared reference.
        out[key] = JSON.parse(json) as unknown;
        break;
      }
    }
  }
  const invalid = def.validate?.(out) ?? null;
  if (invalid) {
    return { ok: false, error: invalid };
  }
  return { ok: true, args: out };
}
