import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import type { BusinessHost } from "./business";
import { t, type MessageId } from "../i18n";
import { emptyBusiness } from "./business";
import {
  beginBusinessLinkedAttach,
  beginBusinessLinkedCreate,
  editBusinessLinkedAttach,
  editBusinessLinkedCreate,
  linkedCreatePlan,
  applyBusinessLinkedPlan,
  loadBusinessLinkedPlans,
  submitBusinessLinkedCreate,
  loadBusinessLinkedCase,
  submitBusinessLinkedAttach,
} from "./business-linked";
import { DEFAULT_PROJECTS_STATE } from "./projects";

function linkedCase() {
  return {
    parentId: "i1",
    plan: {
      steps: [
        { key: "accounts", department: "it", title: { en: "Accounts" }, dependsOn: [] },
        { key: "payroll", department: "hr", title: { en: "Payroll" }, dependsOn: ["accounts"] },
      ],
    },
    steps: [
      { key: "accounts", department: "it", state: "done" },
      { key: "payroll", department: "hr", state: "ready" },
    ],
    ready: ["payroll"],
    done: 1,
    total: 2,
    complete: false,
    blocked: false,
    children: { accounts: "c1" },
    missing: [] as string[],
  };
}

function fixture(answer: () => Promise<unknown>) {
  const item = { id: "i1", projectId: "p1", revision: 3 } as NonNullable<
    BusinessHost["business"]["item"]
  >;
  const request = vi.fn().mockImplementation(answer);
  const host: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", selectedId: "i1", item },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { host, item, request };
}

describe("Business linked case panel", () => {
  it("reads the selected item's linked case without writing", async () => {
    const { host, item, request } = fixture(async () => ({ linkedCase: linkedCase() }));
    await loadBusinessLinkedCase(host, item);
    expect(request.mock.calls).toEqual([["workitems.linked.get", { projectId: "p1", id: "i1" }]]);
    expect(host.business.linked).toMatchObject({ itemId: "i1", revision: 3, status: "ready" });
    expect(host.business.linked?.linkedCase?.children).toEqual({ accounts: "c1" });
  });

  it("hides the panel when the item has no linked case", async () => {
    const { host, item } = fixture(async () => ({ linkedCase: null }));
    await loadBusinessLinkedCase(host, item);
    expect(host.business.linked?.status).toBe("none");
  });

  it.each(["parent", "steps", "state", "total", "title", "dependsOn"])(
    "never shows a malformed %s answer",
    async (kind) => {
      const value = linkedCase() as ReturnType<typeof linkedCase> & Record<string, unknown>;
      if (kind === "parent") {
        value.parentId = "other";
      }
      if (kind === "steps") {
        value.steps = value.steps.slice(1);
      }
      if (kind === "state") {
        value.steps[0] = { ...value.steps[0], state: "approved" };
      }
      if (kind === "total") {
        value.total = 5;
      }
      if (kind === "title") {
        value.plan.steps[1] = { ...value.plan.steps[1], title: undefined as never };
      }
      if (kind === "dependsOn") {
        value.plan.steps[1] = { ...value.plan.steps[1], dependsOn: undefined as never };
      }
      const { host, item } = fixture(async () => ({ linkedCase: value }));
      await loadBusinessLinkedCase(host, item);
      expect(host.business.linked).toMatchObject({ status: "unavailable", linkedCase: null });
    },
  );

  it("keeps only a known refusal code from a failure", async () => {
    const { host, item } = fixture(async () => {
      throw Object.assign(new Error("/srv/private/links.json"), {
        details: { code: "linked_case_corrupt" },
      });
    });
    await loadBusinessLinkedCase(host, item);
    expect(host.business.linked).toMatchObject({
      status: "refused",
      refusal: "linked_case_corrupt",
    });
    expect(JSON.stringify(host.business.linked)).not.toContain("private");
  });

  it("treats an unknown failure code as unavailable", async () => {
    const { host, item } = fixture(async () => {
      throw Object.assign(new Error("boom"), { details: { code: "not_a_linked_code" } });
    });
    await loadBusinessLinkedCase(host, item);
    expect(host.business.linked).toMatchObject({ status: "unavailable", refusal: null });
  });

  it("drops an answer that arrives after the user moved to another item", async () => {
    let resolve!: (value: unknown) => void;
    const { host, item } = fixture(() => new Promise((r) => (resolve = r)));
    const pending = loadBusinessLinkedCase(host, item);
    host.business = { ...host.business, item: { ...item, id: "i2" }, selectedId: "i2" };
    resolve({ linkedCase: linkedCase() });
    await pending;
    expect(host.business.linked?.status).toBe("loading");
  });
});

describe("Business linked case attach", () => {
  async function ready(answer: (method: string) => Promise<unknown>) {
    const f = fixture(async () => ({ linkedCase: linkedCase() }));
    await loadBusinessLinkedCase(f.host, f.item);
    f.request.mockReset().mockImplementation((method: string) => answer(method));
    return f;
  }

  it("attaches only a ready step and reads progress back", async () => {
    const attached = { ...linkedCase(), children: { accounts: "c1", payroll: "c2" } };
    attached.steps[1] = { ...attached.steps[1], state: "open" };
    const { host, request } = await ready(async (method) => ({ linkedCase: attached, method }));
    beginBusinessLinkedAttach(host, "accounts");
    expect(host.business.linkedAttach).toBeNull();
    beginBusinessLinkedAttach(host, "payroll");
    editBusinessLinkedAttach(host, "  c2 ");
    await submitBusinessLinkedAttach(host);
    expect(request.mock.calls).toEqual([
      ["workitems.linked.attach", { projectId: "p1", id: "i1", stepKey: "payroll", childId: "c2" }],
      ["workitems.linked.get", { projectId: "p1", id: "i1" }],
    ]);
    expect(host.business.linkedAttach).toMatchObject({ pending: false, childId: "" });
    expect(host.business.linkedAttach?.notice).toBeTruthy();
    expect(host.business.linked?.linkedCase?.children).toEqual({ accounts: "c1", payroll: "c2" });
  });

  it("shows a known refusal, keeps the form and still reads back", async () => {
    const { host, request } = await ready(async (method) => {
      if (method === "workitems.linked.attach") {
        throw Object.assign(new Error("/srv/secret path"), {
          details: { code: "linked_child_wrong_department" },
        });
      }
      return { linkedCase: linkedCase() };
    });
    beginBusinessLinkedAttach(host, "payroll");
    editBusinessLinkedAttach(host, "c9");
    await submitBusinessLinkedAttach(host);
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "workitems.linked.attach",
      "workitems.linked.get",
    ]);
    expect(host.business.linkedAttach).toMatchObject({ pending: false, childId: "c9" });
    expect(host.business.linkedAttach?.notice).not.toContain("/srv");
    expect(host.business.linkedAttach?.notice).toBe(
      t("business.linked.refusal.linked_child_wrong_department" as MessageId),
    );
  });

  it.each(["", "i1", "x".repeat(201)])("refuses child id %j without writing", async (childId) => {
    const { host, request } = await ready(async () => ({}));
    beginBusinessLinkedAttach(host, "payroll");
    editBusinessLinkedAttach(host, childId);
    await submitBusinessLinkedAttach(host);
    expect(request).not.toHaveBeenCalled();
    expect(host.business.linkedAttach?.notice).toBeTruthy();
  });

  it("does not write when the item moved to a new revision", async () => {
    const { host, item, request } = await ready(async () => ({}));
    beginBusinessLinkedAttach(host, "payroll");
    editBusinessLinkedAttach(host, "c2");
    host.business = { ...host.business, item: { ...item, revision: 4 } };
    await submitBusinessLinkedAttach(host);
    expect(request).not.toHaveBeenCalled();
  });

  it("drops the answer when another item is selected meanwhile", async () => {
    let release: (v: unknown) => void = () => {};
    const { host, item, request } = await ready(
      () => new Promise((resolve) => (release = resolve)),
    );
    beginBusinessLinkedAttach(host, "payroll");
    editBusinessLinkedAttach(host, "c2");
    const done = submitBusinessLinkedAttach(host);
    host.business = { ...host.business, item: { ...item, id: "i2" }, selectedId: "i2" };
    release({ linkedCase: linkedCase() });
    await done;
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.business.linkedAttach).toBeNull();
  });
});

describe("Business linked case create", () => {
  async function none(answer: (method: string) => Promise<unknown>) {
    const f = fixture(async () => ({ linkedCase: null }));
    await loadBusinessLinkedCase(f.host, f.item);
    f.request.mockReset().mockImplementation((method: string) => answer(method));
    return f;
  }

  function fill(host: BusinessHost) {
    beginBusinessLinkedCreate(host);
    editBusinessLinkedCreate(host, 0, { department: "it", title: " Accounts " });
    editBusinessLinkedCreate(host, 1, { department: "hr", title: "Payroll" });
  }

  it("labels a typed step with its typing language after the screen language changes", async () => {
    const { host } = await none(async () => ({}));
    beginBusinessLinkedCreate(host);
    editBusinessLinkedCreate(host, 0, { department: "it", title: "Accounts" }, "en");
    const plan = linkedCreatePlan(host.business.linkedCreate!.steps, "ja");
    expect(plan?.steps[0].title).toEqual({ en: "Accounts" });
  });

  it("starts a plan with ordered keys, then reads the case back", async () => {
    const { host, request } = await none(async () => ({ linkedCase: linkedCase() }));
    fill(host);
    await submitBusinessLinkedCreate(host, "en");
    expect(request.mock.calls).toEqual([
      [
        "workitems.linked.create",
        {
          projectId: "p1",
          id: "i1",
          plan: {
            steps: [
              { key: "step-1", department: "it", title: { en: "Accounts" }, dependsOn: [] },
              { key: "step-2", department: "hr", title: { en: "Payroll" }, dependsOn: ["step-1"] },
            ],
          },
        },
      ],
      ["workitems.linked.get", { projectId: "p1", id: "i1" }],
    ]);
    expect(host.business.linkedCreate).toMatchObject({ pending: false, steps: [] });
    expect(host.business.linkedCreate?.notice).toBe(t("business.linked.create.saved" as MessageId));
    expect(host.business.linked?.status).toBe("ready");
  });

  it("does not offer a plan when the item already has a linked case", async () => {
    const f = fixture(async () => ({ linkedCase: linkedCase() }));
    await loadBusinessLinkedCase(f.host, f.item);
    beginBusinessLinkedCreate(f.host);
    expect(f.host.business.linkedCreate).toBeNull();
  });

  it("writes the title in the screen language and lets a step run in parallel", () => {
    const plan = linkedCreatePlan(
      [
        { department: "it", title: "アカウント", after: [] },
        { department: "hr", title: "給与", after: [] },
      ],
      "ja",
    );
    expect(plan?.steps.map((s) => [s.title, s.dependsOn])).toEqual([
      [{ ja: "アカウント" }, []],
      [{ ja: "給与" }, []],
    ]);
  });

  it.each([
    ["no department", { department: "", title: "Payroll" }],
    ["unknown department", { department: "nope", title: "Payroll" }],
    ["blank step", { department: "hr", title: "  " }],
    ["long step", { department: "hr", title: "x".repeat(201) }],
  ])("refuses a %s without writing", async (_name, step) => {
    const { host, request } = await none(async () => ({}));
    fill(host);
    editBusinessLinkedCreate(host, 1, step);
    await submitBusinessLinkedCreate(host, "en");
    expect(request).not.toHaveBeenCalled();
    expect(host.business.linkedCreate?.notice).toBe(
      t("business.linked.create.invalid" as MessageId),
    );
  });

  it("maps parallel branches that join into one later step", () => {
    const plan = linkedCreatePlan(
      [
        { department: "hr", title: "Scope", after: [] },
        { department: "procurement", title: "Equipment", after: [0] },
        { department: "admin", title: "Desk", after: [0] },
        { department: "it", title: "Access", after: [2, 1, 1] },
      ],
      "en",
    );
    expect(plan?.steps.map((s) => s.dependsOn)).toEqual([
      [],
      ["step-1"],
      ["step-1"],
      ["step-2", "step-3"],
    ]);
  });

  it("never lets a step wait for itself or a later step", async () => {
    const { host } = await none(async () => ({}));
    fill(host);
    editBusinessLinkedCreate(host, 2, { department: "admin", title: "Desk" });
    editBusinessLinkedCreate(host, 1, { after: [1, 2, -1, 0.5, 0] });
    expect(host.business.linkedCreate?.steps.map((s) => s.after)).toEqual([[], [0], [1]]);
  });

  it("re-links a removed step's waiters to what it waited for", async () => {
    const { host } = await none(async () => ({}));
    fill(host);
    editBusinessLinkedCreate(host, 2, { department: "admin", title: "Desk", after: [] });
    editBusinessLinkedCreate(host, 3, { department: "it", title: "Access", after: [1, 2] });
    editBusinessLinkedCreate(host, 1, null);
    // Access waited for Payroll, which waited for Accounts: it still waits for Accounts.
    expect(host.business.linkedCreate?.steps.map((s) => [s.title, s.after])).toEqual([
      [" Accounts ", []],
      ["Desk", []],
      ["Access", [0, 1]],
    ]);
  });

  it("keeps the first step free of a dependency and never removes the last row", async () => {
    const { host } = await none(async () => ({}));
    fill(host);
    editBusinessLinkedCreate(host, 0, null);
    expect(host.business.linkedCreate?.steps).toEqual([
      { department: "hr", title: "Payroll", after: [] },
    ]);
    editBusinessLinkedCreate(host, 0, null);
    expect(host.business.linkedCreate?.steps).toHaveLength(1);
  });

  it("shows a known refusal, keeps the steps and still reads back", async () => {
    const { host, request } = await none(async (method) => {
      if (method === "workitems.linked.create") {
        throw Object.assign(new Error("/srv/secret path"), {
          details: { code: "linked_case_exists" },
        });
      }
      return { linkedCase: linkedCase() };
    });
    fill(host);
    await submitBusinessLinkedCreate(host, "en");
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "workitems.linked.create",
      "workitems.linked.get",
    ]);
    expect(host.business.linkedCreate?.steps).toHaveLength(2);
    expect(host.business.linkedCreate?.notice).toBe(
      t("business.linked.refusal.linked_case_exists" as MessageId),
    );
  });

  it("does not write when the item moved to a new revision", async () => {
    const { host, item, request } = await none(async () => ({}));
    fill(host);
    host.business = { ...host.business, item: { ...item, revision: 4 } };
    await submitBusinessLinkedCreate(host, "en");
    expect(request).not.toHaveBeenCalled();
    expect(host.business.linkedCreate?.notice).toBe(
      t("business.linked.create.changed" as MessageId),
    );
  });

  it("drops the answer when another item is selected meanwhile", async () => {
    let release: (v: unknown) => void = () => {};
    const { host, item, request } = await none(() => new Promise((resolve) => (release = resolve)));
    fill(host);
    const done = submitBusinessLinkedCreate(host, "en");
    host.business = { ...host.business, item: { ...item, id: "i2" }, selectedId: "i2" };
    release({ linkedCase: linkedCase() });
    await done;
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.business.linkedCreate).toBeNull();
  });
});

describe("Business linked case pack plans", () => {
  const onboarding = {
    file: "requests/onboarding.md",
    plan: {
      steps: [
        {
          key: "hr-contract",
          department: "hr",
          title: { en: "Contract", ja: "契約" },
          dependsOn: [],
        },
        { key: "it-account", department: "it", title: { en: "Account" }, dependsOn: [] },
        {
          key: "ga-desk",
          department: "admin",
          title: { en: "Desk", ja: "座席" },
          dependsOn: ["it-account", "hr-contract"],
        },
      ],
    },
    sourceKeys: {},
    problems: [],
  };

  async function open(plans: unknown, fail = false) {
    const f = fixture(async () => ({ linkedCase: null }));
    await loadBusinessLinkedCase(f.host, f.item);
    f.request.mockReset().mockImplementation(async () => {
      if (fail) {
        throw new Error("/srv/secret path");
      }
      return { plans };
    });
    beginBusinessLinkedCreate(f.host);
    await loadBusinessLinkedPlans(f.host);
    return f;
  }

  it("reads offered plans read-only and prefills every dependency in the screen language", async () => {
    const { host, request } = await open([onboarding]);
    expect(request.mock.calls).toEqual([["workitems.linked.plans", { projectId: "p1", id: "i1" }]]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "ja");
    expect(host.business.linkedCreate?.steps).toMatchObject([
      { department: "hr", title: "契約", after: [] },
      { department: "it", title: "Account", after: [] },
      { department: "admin", title: "座席", after: [0, 1] },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("submits the worksheet's titles as written until the person edits one", async () => {
    const { host } = await open([onboarding]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "ja");
    const titles = () =>
      linkedCreatePlan(host.business.linkedCreate!.steps, "ja")?.steps.map((s) => s.title);
    // An English-only worksheet title stays English even on a Japanese screen.
    expect(titles()).toEqual([
      { en: "Contract", ja: "契約" },
      { en: "Account" },
      { en: "Desk", ja: "座席" },
    ]);
    editBusinessLinkedCreate(host, 0, { department: "legal" });
    expect(titles()?.[0]).toEqual({ en: "Contract", ja: "契約" });
    editBusinessLinkedCreate(host, 0, { title: "雇用契約" });
    expect(titles()).toEqual([{ ja: "雇用契約" }, { en: "Account" }, { en: "Desk", ja: "座席" }]);
  });

  it("shows a worksheet title in its only language when the screen language is missing", async () => {
    const jaOnly = {
      ...onboarding,
      plan: {
        steps: [
          { key: "hr-contract", department: "hr", title: { ja: "契約" }, dependsOn: [] },
          {
            key: "it-account",
            department: "it",
            title: { en: " ", ja: "アカウント" },
            dependsOn: [],
          },
        ],
      },
    };
    const { host } = await open([jaOnly]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "en");
    expect(host.business.linkedCreate?.steps.map((s) => s.title)).toEqual(["契約", "アカウント"]);
    // The Japanese-only title is still sent as Japanese, not relabelled as the screen language.
    const plan = linkedCreatePlan(host.business.linkedCreate!.steps, "en");
    expect(plan?.steps.map((s) => s.title)).toEqual([{ ja: "契約" }, { ja: "アカウント" }]);
  });

  it("labels an edited title with the language it was typed in, not the submit language", async () => {
    const { host } = await open([onboarding]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "en");
    editBusinessLinkedCreate(host, 0, { title: "Updated contract" }, "en");
    editBusinessLinkedCreate(host, 1, { department: "legal" }, "ja");
    const plan = linkedCreatePlan(host.business.linkedCreate!.steps, "ja");
    expect(plan?.steps.map((s) => s.title)).toEqual([
      { en: "Updated contract" },
      { en: "Account" },
      { en: "Desk", ja: "座席" },
    ]);
  });

  it("shows each prefilled step's worksheet key without sending it", async () => {
    const { host } = await open([{ ...onboarding, sourceKeys: { "hr-contract": "hr.contract" } }]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "en");
    expect(host.business.linkedCreate?.steps.map((s) => s.source)).toEqual([
      "hr.contract",
      "it-account",
      "ga-desk",
    ]);
    // A removed row takes its key with it; the rows below keep theirs as their step-N shifts.
    editBusinessLinkedCreate(host, 0, null);
    editBusinessLinkedCreate(host, 1, { title: "Seat" }, "en");
    editBusinessLinkedCreate(host, 2, {});
    expect(host.business.linkedCreate?.steps.map((s) => s.source)).toEqual([
      "it-account",
      "ga-desk",
      undefined,
    ]);
    editBusinessLinkedCreate(host, 2, { department: "hr", title: "Badge" }, "en");
    const plan = linkedCreatePlan(host.business.linkedCreate!.steps, "en");
    expect(JSON.stringify(plan)).not.toMatch(/it-account|ga-desk|source/);
  });

  it("moves prerequisites written below a step ahead of it, otherwise keeping worksheet order", async () => {
    const step = (key: string, dependsOn: string[]) => ({
      key,
      department: "hr",
      title: { en: key.toUpperCase() },
      dependsOn,
    });
    const { host } = await open([
      {
        ...onboarding,
        plan: {
          steps: [step("d", ["c"]), step("a", []), step("c", ["b"]), step("b", []), step("e", [])],
        },
        sourceKeys: { c: "x.c" },
      },
    ]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "en");
    const steps = host.business.linkedCreate!.steps;
    expect(steps.map((s) => [s.source, s.after])).toEqual([
      ["a", []],
      ["b", []],
      ["x.c", [1]],
      ["d", [2]],
      ["e", []],
    ]);
    expect(linkedCreatePlan(steps, "en")?.steps.map((s) => [s.title, s.dependsOn])).toEqual([
      [{ en: "A" }, []],
      [{ en: "B" }, []],
      [{ en: "C" }, ["step-2"]],
      [{ en: "D" }, ["step-3"]],
      [{ en: "E" }, []],
    ]);
  });

  it("refuses a prefilled step whose other-language title is too long", async () => {
    const long = { ...onboarding.plan.steps[0], title: { ja: "契約", en: "x".repeat(201) } };
    const { host } = await open([{ ...onboarding, plan: { steps: [long] } }]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "ja");
    expect(linkedCreatePlan(host.business.linkedCreate!.steps, "ja")).toBeNull();
  });

  it.each([
    [
      "a problem",
      { ...onboarding, plan: null, problems: [{ code: "untrusted_file" }] },
      "problems",
      ["untrusted_file"],
    ],
    [
      "a plan reported alongside a problem",
      { ...onboarding, problems: [{ code: "bad_title" }, { code: "bad_title" }, { code: 7 }] },
      "problems",
      ["bad_title"],
    ],
    [
      "a dependency cycle",
      {
        ...onboarding,
        plan: {
          steps: [
            { key: "a", department: "hr", title: { en: "A" }, dependsOn: ["b"] },
            { key: "b", department: "it", title: { en: "B" }, dependsOn: ["a"] },
          ],
        },
      },
      "order",
      [],
    ],
    [
      "a step that waits for itself",
      {
        ...onboarding,
        plan: { steps: [{ key: "a", department: "hr", title: { en: "A" }, dependsOn: ["a"] }] },
      },
      "order",
      [],
    ],
    [
      "an unknown dependency",
      {
        ...onboarding,
        plan: { steps: [{ key: "a", department: "hr", title: { en: "A" }, dependsOn: ["zz"] }] },
      },
      "order",
      [],
    ],
    [
      "a malformed step",
      { ...onboarding, plan: { steps: [{ key: "a", department: "hr", dependsOn: [] }] } },
      "unreadable",
      [],
    ],
    [
      "more steps than the form holds",
      {
        ...onboarding,
        plan: {
          steps: Array.from({ length: 33 }, (_, i) => ({
            key: `s${i}`,
            department: "hr",
            title: { en: "S" },
            dependsOn: [],
          })),
        },
      },
      "size",
      [],
    ],
  ])("does not offer a plan with %s, and says why", async (_, entry, reason, problems) => {
    const { host } = await open([entry]);
    expect(host.business.linkedCreate?.plans).toEqual([]);
    expect(host.business.linkedCreate?.omitted).toEqual([
      { file: "requests/onboarding.md", reason, problems },
    ]);
    applyBusinessLinkedPlan(host, "requests/onboarding.md", "en");
    expect(host.business.linkedCreate?.steps).toEqual([{ department: "", title: "", after: [] }]);
  });

  it("keeps the hand-written form when the plans cannot be read", async () => {
    const { host } = await open(undefined, true);
    expect(host.business.linkedCreate).toMatchObject({ plans: [], omitted: [], notice: null });
  });

  it("offers clean plans beside the omitted ones and skips an entry without a file", async () => {
    const { host } = await open([
      {
        ...onboarding,
        file: "requests/broken.md",
        plan: null,
        problems: [{ code: "no_manifest" }],
      },
      { ...onboarding, file: 3 },
      onboarding,
    ]);
    expect(host.business.linkedCreate?.plans?.map((p) => p.file)).toEqual([
      "requests/onboarding.md",
    ]);
    expect(host.business.linkedCreate?.omitted).toEqual([
      { file: "requests/broken.md", reason: "problems", problems: ["no_manifest"] },
    ]);
  });

  it("drops plans read for an item that is no longer on screen", async () => {
    const f = fixture(async () => ({ linkedCase: null }));
    await loadBusinessLinkedCase(f.host, f.item);
    let release: (v: unknown) => void = () => {};
    f.request.mockReset().mockImplementation(() => new Promise((r) => (release = r)));
    beginBusinessLinkedCreate(f.host);
    const loading = loadBusinessLinkedPlans(f.host);
    f.host.business = { ...f.host.business, linkedCreate: null };
    release({ plans: [onboarding] });
    await loading;
    expect(f.host.business.linkedCreate).toBeNull();
  });
});
