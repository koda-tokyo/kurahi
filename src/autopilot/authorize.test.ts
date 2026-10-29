import { afterEach, describe, expect, it } from "vitest";
import type { AutonomyLevel, ProposedAction, StandingApproval } from "./types.js";
import {
  getActionDef,
  listActionDefs,
  registerAutopilotAction,
  resetAutopilotActionsForTests,
} from "./actions.js";
import { authorizeAction, type AuthorizeContext, type AuthorizeRoutine } from "./authorize.js";
import { AUTONOMY_LEVELS, BLOCKING_FLAGS } from "./types.js";

const NOW = new Date("2026-10-25T03:00:00Z");
const DAY = 86_400_000;

const MAIL = {
  to: ["tanaka@client.example.jp"],
  subject: "日程のご確認",
  body: "本文",
  templateId: "schedule-reply",
};
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  "workitem.intake": { title: "確認" },
  "mail.draft": { to: ["a@b.example"], subject: "s", body: "b" },
  "mail.attach": {},
  "office.create": {
    kind: "docx",
    file: "reply.docx",
    spec: { title: "t", blocks: [{ type: "paragraph", text: "p" }] },
  },
  "files.upload": { path: "output/a.pdf" },
  "calendar.propose": { title: "t", slots: ["2026-10-27T10:00+09:00"] },
  "mail.send": MAIL,
  "legacy.analyze": { path: "source" },
  "legacy.design_doc": { path: "source" },
  "po.prepare": { case: "wi_sample" },
  "quote.prepare": {
    quote: {
      customer: "株式会社サンプル",
      subject: "御見積",
      lines: [{ description: "部品A", quantity: 10 }],
    },
  },
  "legacy.baseline_advance": { path: "source" },
  "research.search": { query: "q" },
  "repo.open_pr": { repo: "acme/app", title: "t" },
  "brief.deliver": { principal: "device:abc123def456" },
};

function routine(level: AutonomyLevel, actions: string[], edition = "business" as const) {
  return {
    id: "r1",
    edition,
    level,
    actions,
    limits: { maxItemsPerRun: 10, maxActionsPerDay: 100 },
  } as AuthorizeRoutine;
}

function approval(over: Partial<StandingApproval> = {}): StandingApproval {
  return {
    id: "sappr0000000001",
    projectId: "pabcdefghij",
    routineId: "r1",
    action: "mail.send",
    scope: {
      addresses: [],
      domains: ["client.example.jp"],
      targets: [],
      templates: ["schedule-reply"],
      maxPerDay: 5,
    },
    reason: "routine scheduling replies to known clients",
    createdBy: "device:person",
    createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...over,
  };
}

function ctx(over: Partial<AuthorizeContext> = {}): AuthorizeContext {
  return { now: NOW, flags: [], approvals: [], actionsToday: 0, approvalUsesToday: {}, ...over };
}

const act = (kind: string, args?: Record<string, unknown>): ProposedAction => ({
  kind,
  args: args ?? SAMPLE_ARGS[kind] ?? {},
});

afterEach(() => resetAutopilotActionsForTests());

describe("authorizeAction: level × class matrix", () => {
  const expected: Record<AutonomyLevel, Record<string, string>> = {
    L0: { prepare: "refuse", "internal-reversible": "refuse", external: "refuse" },
    L1: { prepare: "allow", "internal-reversible": "needs_person", external: "needs_person" },
    L2: { prepare: "allow", "internal-reversible": "allow", external: "needs_person" },
    // L3 without a standing approval: external still needs a person.
    L3: { prepare: "allow", "internal-reversible": "allow", external: "needs_person" },
  };

  for (const level of AUTONOMY_LEVELS) {
    for (const def of listActionDefs()) {
      if (def.class === "never") {
        continue;
      }
      it(`${level} ${def.id} (${def.class})`, () => {
        const edition = def.editions[0];
        const d = authorizeAction(routine(level, [def.id], edition as never), act(def.id), ctx());
        expect(d.decision).toBe(expected[level][def.class]);
        expect(d.class).toBe(def.class);
      });
    }
  }

  it("internal-reversible is decided by the class (a registered action)", () => {
    registerAutopilotAction({
      id: "files.route",
      class: "internal-reversible",
      editions: ["business"],
      label: { en: "Route", ja: "回付" },
      executor: "none",
      tools: [],
      args: {},
      source: "test",
    });
    expect(
      authorizeAction(routine("L1", ["files.route"]), act("files.route"), ctx()).decision,
    ).toBe("needs_person");
    expect(
      authorizeAction(routine("L2", ["files.route"]), act("files.route"), ctx()).decision,
    ).toBe("allow");
  });
});

describe("authorizeAction: never list", () => {
  const nevers = listActionDefs().filter((d) => d.class === "never");
  it("ships the never classifications", () => {
    for (const id of [
      "payment.execute",
      "bank.change",
      "contract.sign",
      "ot.write",
      "plc.write",
      "deploy",
      "journal.submit",
      "grant.submit",
      "participant.contact",
      "secrets.change",
      "data.delete",
    ]) {
      expect(getActionDef(id)?.class).toBe("never");
    }
    expect(getActionDef("legacy.analyze")?.class).toBe("prepare");
    expect(getActionDef("legacy.design_doc")?.class).toBe("prepare");
    expect(getActionDef("research.search")?.class).toBe("prepare");
    expect(getActionDef("repo.open_pr")?.class).toBe("external");
  });

  for (const level of AUTONOMY_LEVELS) {
    for (const def of nevers) {
      it(`${level} ${def.id} → needs_person, even with a matching approval`, () => {
        const r = routine(level, [def.id], def.editions[0] as never);
        const d = authorizeAction(
          r,
          act(def.id),
          ctx({ approvals: [approval({ action: def.id })] }),
        );
        expect(d).toMatchObject({ decision: "needs_person", code: "never_autonomous" });
      });
    }
  }

  it("a registration can never loosen a class", () => {
    expect(() =>
      registerAutopilotAction({
        ...getActionDef("payment.execute")!,
        class: "prepare",
        executor: "tool",
        tools: ["x"],
      }),
    ).toThrow(/cannot be re-registered/);
    expect(() =>
      registerAutopilotAction({ ...getActionDef("mail.send")!, class: "prepare" }),
    ).toThrow(/cannot be re-registered/);
    // Tightening is allowed, and a never action loses any executor.
    registerAutopilotAction({ ...getActionDef("mail.send")!, class: "never" });
    expect(getActionDef("mail.send")).toMatchObject({
      class: "never",
      executor: "none",
      tools: [],
    });
  });
});

describe("authorizeAction: flags", () => {
  for (const flag of BLOCKING_FLAGS) {
    for (const level of AUTONOMY_LEVELS) {
      it(`${flag} at ${level} refuses every action`, () => {
        for (const kind of ["workitem.intake", "mail.draft", "mail.send"]) {
          const d = authorizeAction(
            routine(level, ["workitem.intake", "mail.draft", "mail.send"]),
            act(kind),
            ctx({ flags: [flag], approvals: [approval()] }),
          );
          expect(d).toMatchObject({ decision: "refuse", code: "flagged" });
        }
      });
    }
  }
  it("informational flags do not block", () => {
    expect(
      authorizeAction(
        routine("L1", ["mail.draft"]),
        act("mail.draft"),
        ctx({ flags: ["duplicate"] }),
      ).decision,
    ).toBe("allow");
  });
});

describe("authorizeAction: L3 standing approvals", () => {
  const r3 = routine("L3", ["mail.send"]);
  const cases: Array<[string, Partial<AuthorizeContext>, ProposedAction, string, string | null]> = [
    ["valid approval", { approvals: [approval()] }, act("mail.send"), "allow", null],
    ["no approval", {}, act("mail.send"), "needs_person", "no_standing_approval"],
    [
      "expired",
      { approvals: [approval({ expiresAt: new Date(NOW.getTime() - 1).toISOString() })] },
      act("mail.send"),
      "needs_person",
      "approval_expired",
    ],
    [
      "revoked",
      {
        approvals: [
          approval({ revokedAt: NOW.toISOString(), revokedBy: "device:x", revokeReason: "stop" }),
        ],
      },
      act("mail.send"),
      "needs_person",
      "approval_revoked",
    ],
    [
      "recipient domain out of scope",
      { approvals: [approval()] },
      act("mail.send", { ...MAIL, to: ["ceo@other.example"] }),
      "needs_person",
      "recipient_out_of_scope",
    ],
    [
      "one recipient of two out of scope (cc)",
      { approvals: [approval()] },
      act("mail.send", { ...MAIL, cc: ["x@evil.example"] }),
      "needs_person",
      "recipient_out_of_scope",
    ],
    [
      "look-alike subdomain",
      { approvals: [approval()] },
      act("mail.send", { ...MAIL, to: ["a@client.example.jp.evil.example"] }),
      "needs_person",
      "recipient_out_of_scope",
    ],
    [
      "exact address allowlist",
      {
        approvals: [
          approval({
            scope: { ...approval().scope, domains: [], addresses: ["tanaka@client.example.jp"] },
          }),
        ],
      },
      act("mail.send"),
      "allow",
      null,
    ],
    [
      "template out of scope",
      { approvals: [approval()] },
      act("mail.send", { ...MAIL, templateId: "free-text" }),
      "needs_person",
      "template_out_of_scope",
    ],
    [
      "no template",
      { approvals: [approval()] },
      act("mail.send", { ...MAIL, templateId: undefined }),
      "needs_person",
      "template_out_of_scope",
    ],
    [
      "approval daily maximum reached",
      { approvals: [approval()], approvalUsesToday: { sappr0000000001: 5 } },
      act("mail.send"),
      "needs_person",
      "approval_daily_limit",
    ],
    [
      "approval for another routine",
      { approvals: [approval({ routineId: "other" })] },
      act("mail.send"),
      "needs_person",
      "no_standing_approval",
    ],
    [
      "approval for another action",
      { approvals: [approval({ action: "repo.open_pr" })] },
      act("mail.send"),
      "needs_person",
      "no_standing_approval",
    ],
    [
      "routine daily limit",
      { approvals: [approval()], actionsToday: 100 },
      act("mail.send"),
      "needs_person",
      "daily_limit",
    ],
  ];
  for (const [name, c, a, decision, code] of cases) {
    it(name, () => {
      const d = authorizeAction(r3, a, ctx(c));
      expect(d.decision).toBe(decision);
      if (code) {
        expect(d).toMatchObject({ code });
      } else {
        expect(d).toMatchObject({ approvalId: "sappr0000000001" });
      }
    });
  }

  it("a valid approval does nothing below L3", () => {
    for (const level of ["L1", "L2"] as const) {
      const d = authorizeAction(
        routine(level, ["mail.send"]),
        act("mail.send"),
        ctx({ approvals: [approval()] }),
      );
      expect(d).toMatchObject({ decision: "needs_person", code: "level_too_low" });
    }
  });

  it("picks the approval that covers the send", () => {
    const narrow = approval({
      id: "snarrow00000001",
      scope: { ...approval().scope, domains: ["x.example"] },
    });
    const d = authorizeAction(r3, act("mail.send"), ctx({ approvals: [narrow, approval()] }));
    expect(d).toMatchObject({ decision: "allow", approvalId: "sappr0000000001" });
  });

  it("repo.open_pr checks targets", () => {
    const r = routine("L3", ["repo.open_pr"], "industrial" as never);
    const a = approval({
      action: "repo.open_pr",
      scope: { addresses: [], domains: [], targets: ["acme/app"], templates: [], maxPerDay: 2 },
    });
    expect(authorizeAction(r, act("repo.open_pr"), ctx({ approvals: [a] })).decision).toBe("allow");
    expect(
      authorizeAction(
        r,
        act("repo.open_pr", { repo: "acme/other", title: "t" }),
        ctx({ approvals: [a] }),
      ),
    ).toMatchObject({ decision: "needs_person", code: "target_out_of_scope" });
  });
});

describe("authorizeAction: the model cannot widen anything", () => {
  it("refuses actions the routine does not list", () => {
    expect(
      authorizeAction(
        routine("L3", ["mail.draft"]),
        act("mail.send"),
        ctx({ approvals: [approval()] }),
      ),
    ).toMatchObject({ decision: "refuse", code: "not_in_routine" });
  });
  it("refuses unknown actions and editions that do not have them", () => {
    expect(authorizeAction(routine("L3", []), act("shell.exec"), ctx())).toMatchObject({
      decision: "refuse",
      code: "unknown_action",
    });
    expect(
      authorizeAction(routine("L1", ["legacy.analyze"]), act("legacy.analyze"), ctx()),
    ).toMatchObject({ decision: "refuse", code: "edition_mismatch" });
  });
  it("refuses extra arguments (no level, approval or tool smuggled in)", () => {
    for (const extra of [
      { level: "L3" },
      { approvalId: "sappr0000000001" },
      { tool: "m365_mail_send" },
    ]) {
      expect(
        authorizeAction(
          routine("L1", ["mail.draft"]),
          act("mail.draft", { ...SAMPLE_ARGS["mail.draft"], ...extra }),
          ctx(),
        ),
      ).toMatchObject({ decision: "refuse", code: "invalid_args" });
    }
  });
  it("office.create needs a known kind, an output file name and a spec; mail.attach takes none", () => {
    const r = routine("L1", ["office.create", "mail.attach"]);
    const spec = SAMPLE_ARGS["office.create"].spec;
    for (const args of [
      { kind: "pdf", file: "a.pdf", spec },
      { kind: "docx", file: "../evil.docx", spec },
      { kind: "docx", file: "output/a.docx", spec },
      { kind: "docx", file: "a.xlsx", spec },
      { kind: "docx", file: "a.docx", spec: "text" },
      { kind: "docx", file: "a.docx" },
    ]) {
      expect(authorizeAction(r, act("office.create", args), ctx())).toMatchObject({
        decision: "refuse",
        code: "invalid_args",
      });
    }
    // The model cannot point the attach at another draft or another file.
    expect(
      authorizeAction(r, act("mail.attach", { draftId: "d1", path: "secrets.txt" }), ctx()),
    ).toMatchObject({ decision: "refuse", code: "invalid_args" });
  });
  it("enforces the routine daily limit for prepare actions too", () => {
    expect(
      authorizeAction(routine("L1", ["mail.draft"]), act("mail.draft"), ctx({ actionsToday: 100 })),
    ).toMatchObject({ decision: "needs_person", code: "daily_limit" });
  });
});

describe("quote.prepare", () => {
  it("refuses lines that carry a price: prices come from the price list", () => {
    const d = authorizeAction(
      routine("L1", ["quote.prepare"], "business" as never),
      act("quote.prepare", {
        quote: {
          customer: "c",
          subject: "s",
          lines: [{ description: "x", quantity: 1, unit_price: 1 }],
        },
      }),
      ctx(),
    );
    expect(d.decision).toBe("refuse");
  });

  it("refuses scope exclusions and revisions from a routine: those are a person's decisions", () => {
    for (const extra of [
      { excluded: [{ description: "x", reason: "out of scope for now" }] },
      { number: "Q-1", revision: 2 },
    ]) {
      const d = authorizeAction(
        routine("L1", ["quote.prepare"], "business" as never),
        act("quote.prepare", {
          quote: {
            customer: "c",
            subject: "s",
            lines: [{ description: "x", quantity: 1 }],
            ...extra,
          },
        }),
        ctx(),
      );
      expect(d.decision).toBe("refuse");
    }
  });
});
