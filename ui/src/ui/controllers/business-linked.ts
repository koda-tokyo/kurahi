import type {
  WorkitemsLinkedAttachParams,
  WorkitemsLinkedAttachResult,
  WorkitemsLinkedCreateParams,
  WorkitemsLinkedCreateResult,
  WorkitemsLinkedGetResult,
} from "../../../../packages/client/src/generated/types";
import type { BusinessHost } from "./business";
import {
  WORK_ITEM_LINKED_REFUSALS,
  type WorkItem,
  type WorkItemLinkedCase,
  type WorkItemLinkedRefusal,
} from "../../../../packages/client/src/workitems";
import { getBusinessDepartment } from "../business-departments";
import { t, type MessageId } from "../i18n";

export type BusinessLinkedCase = {
  itemId: string;
  revision: number;
  status: "loading" | "ready" | "none" | "refused" | "unavailable";
  linkedCase: WorkItemLinkedCase | null;
  refusal: WorkItemLinkedRefusal | null;
};

/** A person's request to record which existing work item handles one ready step. */
export type BusinessLinkedAttach = {
  itemId: string;
  revision: number;
  stepKey: string;
  childId: string;
  pending: boolean;
  notice: string | null;
};

const STEP_STATES = new Set(["waiting", "ready", "open", "done", "cancelled", "stuck"]);

const optionalText = (v: unknown) => v === undefined || typeof v === "string";

/** Every plan field the panel renders: a title object, a department and a list of step keys. */
function renderablePlanStep(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const step = value as Record<string, unknown>;
  const title = step.title as Record<string, unknown> | null | undefined;
  return (
    typeof step.key === "string" &&
    typeof step.department === "string" &&
    !!title &&
    typeof title === "object" &&
    !Array.isArray(title) &&
    optionalText(title.ja) &&
    optionalText(title.en) &&
    Array.isArray(step.dependsOn) &&
    step.dependsOn.every((d) => typeof d === "string")
  );
}

/** Shape check only; the gateway owns readiness. A partial answer is shown as unavailable. */
function wellFormed(value: unknown): value is WorkItemLinkedCase {
  if (!value || typeof value !== "object") {
    return false;
  }
  const c = value as WorkItemLinkedCase;
  return (
    typeof c.parentId === "string" &&
    Array.isArray(c.plan?.steps) &&
    Array.isArray(c.steps) &&
    c.steps.length === c.plan.steps.length &&
    c.plan.steps.every(renderablePlanStep) &&
    c.steps.every(
      (step, i) =>
        step &&
        typeof step.key === "string" &&
        step.key === c.plan.steps[i]?.key &&
        typeof step.department === "string" &&
        STEP_STATES.has(step.state),
    ) &&
    typeof c.done === "number" &&
    typeof c.total === "number" &&
    c.total === c.steps.length &&
    typeof c.complete === "boolean" &&
    typeof c.blocked === "boolean" &&
    !!c.children &&
    typeof c.children === "object" &&
    Array.isArray(c.missing)
  );
}

function refusalOf(error: unknown): WorkItemLinkedRefusal | null {
  const details = error && typeof error === "object" && "details" in error ? error.details : null;
  const code = details && typeof details === "object" && "code" in details ? details.code : null;
  return WORK_ITEM_LINKED_REFUSALS.find((value) => value === code) ?? null;
}

/** Read-only: fetched for the item on screen; creating and attaching are separate writes. */
export async function loadBusinessLinkedCase(host: BusinessHost, item: WorkItem) {
  const client = host.client;
  if (!client || !host.connected) {
    return;
  }
  const pending: BusinessLinkedCase = {
    itemId: item.id,
    revision: item.revision,
    status: "loading",
    linkedCase: null,
    refusal: null,
  };
  host.business = { ...host.business, linked: pending };
  const current = () =>
    host.client === client &&
    host.business.projectId === item.projectId &&
    host.business.item === item &&
    host.business.linked === pending;
  let next: BusinessLinkedCase;
  try {
    const result = await client.request<WorkitemsLinkedGetResult>("workitems.linked.get", {
      projectId: item.projectId,
      id: item.id,
    });
    if (result?.linkedCase === null) {
      next = { ...pending, status: "none" };
    } else if (wellFormed(result?.linkedCase) && result.linkedCase.parentId === item.id) {
      next = { ...pending, status: "ready", linkedCase: result.linkedCase };
    } else {
      next = { ...pending, status: "unavailable" };
    }
  } catch (error) {
    // Transport messages can contain paths; keep only a known refusal code.
    const refusal = refusalOf(error);
    next = { ...pending, status: refusal ? "refused" : "unavailable", refusal };
  }
  if (current()) {
    host.business = { ...host.business, linked: next };
  }
}

const attachInFlight = new WeakSet<BusinessHost>();

/** The step on screen, only while it is ready and has no work item yet. */
function readyStep(host: BusinessHost, stepKey: string) {
  const { item, linked } = host.business;
  if (
    !item ||
    !linked ||
    linked.status !== "ready" ||
    !linked.linkedCase ||
    linked.itemId !== item.id ||
    linked.revision !== item.revision
  ) {
    return null;
  }
  const step = linked.linkedCase.steps.find((s) => s.key === stepKey);
  return step?.state === "ready" && !linked.linkedCase.children[stepKey] ? step : null;
}

export function beginBusinessLinkedAttach(host: BusinessHost, stepKey: string) {
  const item = host.business.item;
  if (!host.connected || !item || attachInFlight.has(host) || !readyStep(host, stepKey)) {
    return;
  }
  host.business = {
    ...host.business,
    linkedAttach: {
      itemId: item.id,
      revision: item.revision,
      stepKey,
      childId: "",
      pending: false,
      notice: null,
    },
  };
}

export function editBusinessLinkedAttach(host: BusinessHost, childId: string) {
  const form = host.business.linkedAttach;
  if (form && !form.pending) {
    host.business = { ...host.business, linkedAttach: { ...form, childId } };
  }
}

export function cancelBusinessLinkedAttach(host: BusinessHost) {
  if (!host.business.linkedAttach?.pending) {
    host.business = { ...host.business, linkedAttach: null };
  }
}

/** A person-confirmed write. Progress is always read back from the gateway, never assumed. */
export async function submitBusinessLinkedAttach(host: BusinessHost) {
  const form = host.business.linkedAttach;
  const client = host.client;
  const item = host.business.item;
  if (!form || form.pending || !client || !host.connected || !item || attachInFlight.has(host)) {
    return;
  }
  const notice = (id: string) => t(id as MessageId);
  if (
    form.itemId !== item.id ||
    form.revision !== item.revision ||
    !readyStep(host, form.stepKey)
  ) {
    host.business = {
      ...host.business,
      linkedAttach: { ...form, notice: notice("business.linked.attach.changed") },
    };
    return;
  }
  const childId = form.childId.trim();
  if (!childId || childId.length > 200 || childId === item.id) {
    host.business = {
      ...host.business,
      linkedAttach: { ...form, notice: notice("business.linked.attach.invalid") },
    };
    return;
  }
  const pending = { ...form, childId, pending: true, notice: null };
  host.business = { ...host.business, linkedAttach: pending };
  attachInFlight.add(host);
  let saved = false;
  let message: string;
  try {
    try {
      const result = await client.request<WorkitemsLinkedAttachResult>("workitems.linked.attach", {
        projectId: item.projectId,
        id: item.id,
        stepKey: form.stepKey,
        childId,
      } satisfies WorkitemsLinkedAttachParams);
      if (result?.linkedCase?.parentId !== item.id) {
        throw new Error("Linked case scope mismatch");
      }
      saved = true;
      message = notice("business.linked.attach.saved");
    } catch (error) {
      const refusal = refusalOf(error);
      message = notice(
        refusal ? `business.linked.refusal.${refusal}` : "business.linked.attach.failed",
      );
    }
  } finally {
    attachInFlight.delete(host);
  }
  const still =
    host.client === client &&
    host.business.item?.id === item.id &&
    host.business.projectId === item.projectId &&
    host.business.linkedAttach === pending;
  if (!still) {
    if (host.business.linkedAttach === pending) {
      host.business = { ...host.business, linkedAttach: null };
    }
    return;
  }
  host.business = {
    ...host.business,
    // Kept after success so the notice stays; the form only renders for a step that is still ready.
    linkedAttach: { ...pending, pending: false, notice: message, childId: saved ? "" : childId },
  };
  // Read back on success and on an uncertain failure alike.
  await loadBusinessLinkedCase(host, host.business.item ?? item);
}

/** One step of a new linked case as a person writes it; keys are assigned on submit. */
export type BusinessLinkedCreateStep = {
  department: string;
  title: string;
  /** Earlier steps (0-based row numbers) that must be done before this one opens. */
  after: number[];
  /**
   * The titles sent for this step: a prefilled step's worksheet titles while the person leaves
   * the title alone, then only the edited title in the language it was typed in, so neither a
   * stale translation nor a later screen-language switch mislabels it.
   */
  titles?: { ja?: string; en?: string };
  /** The worksheet task key a prefilled step came from, shown so the person can record it. */
  source?: string;
};

/** A person's plan for a new linked case on an item that has none. */
export type BusinessLinkedCreate = {
  itemId: string;
  revision: number;
  steps: BusinessLinkedCreateStep[];
  pending: boolean;
  notice: string | null;
  /** Pack worksheet plans the gateway offered for this item, read-only; empty until read. */
  plans?: BusinessPackPlan[];
  /** Worksheet plans the form cannot start from, with the reason, so none disappears silently. */
  omitted?: BusinessPackPlanOmission[];
};

/** Why a worksheet plan is not offered; `problems` carries the gateway's problem codes. */
export type BusinessPackPlanOmission = {
  file: string;
  reason: "problems" | "order" | "size" | "unreadable";
  problems: string[];
};

/** A pack worksheet plan the form can start from. The person still reviews and submits it. */
export type BusinessPackPlan = {
  file: string;
  steps: {
    department: string;
    title: { ja?: string; en?: string };
    after: number[];
    /** The worksheet task key, before the gateway normalized it into a step key. */
    source: string;
  }[];
};

export const LINKED_CREATE_MAX_STEPS = 32;
const LINKED_TITLE_MAX = 200;

const createInFlight = new WeakSet<BusinessHost>();

/** The item on screen, only while the gateway said it has no linked case. */
function withoutLinkedCase(host: BusinessHost) {
  const { item, linked } = host.business;
  return item &&
    linked &&
    linked.status === "none" &&
    linked.itemId === item.id &&
    linked.revision === item.revision
    ? item
    : null;
}

const blankStep = (after: number[]): BusinessLinkedCreateStep => ({
  department: "",
  title: "",
  after,
});

/** Only earlier rows, once each, in order: a step can never wait for itself or a later one. */
const earlier = (after: unknown, index: number) =>
  Array.isArray(after)
    ? [...new Set(after)]
        .filter((j): j is number => Number.isInteger(j) && j >= 0 && j < index)
        .toSorted((a, b) => a - b)
    : [];

export function beginBusinessLinkedCreate(host: BusinessHost) {
  const item = withoutLinkedCase(host);
  if (!host.connected || !item || createInFlight.has(host)) {
    return;
  }
  host.business = {
    ...host.business,
    linkedCreate: {
      itemId: item.id,
      revision: item.revision,
      steps: [blankStep([])],
      pending: false,
      notice: null,
    },
  };
}

/**
 * Add a step at the end (index = steps.length), change one, or remove one (patch = null).
 * `lang` is the screen language a title edit was typed in.
 */
export function editBusinessLinkedCreate(
  host: BusinessHost,
  index: number,
  patch: Partial<BusinessLinkedCreateStep> | null,
  lang?: "en" | "ja",
) {
  const form = host.business.linkedCreate;
  if (!form || form.pending || index < 0 || index > form.steps.length) {
    return;
  }
  let steps = form.steps;
  if (index === steps.length) {
    if (patch === null || steps.length >= LINKED_CREATE_MAX_STEPS) {
      return;
    }
    // A new step waits for the one above it by default.
    steps = [...steps, { ...blankStep([steps.length - 1]), ...patch }];
  } else if (patch === null) {
    if (steps.length <= 1) {
      return;
    }
    // A step that waited for the removed one now waits for what that one waited for,
    // so removing a row never lets a later step open early.
    const inherited = steps[index].after;
    steps = steps
      .filter((_, i) => i !== index)
      .map((step) => ({
        ...step,
        after: step.after
          .flatMap((j) => (j === index ? inherited : [j]))
          .map((j) => (j > index ? j - 1 : j)),
      }));
  } else {
    steps = steps.map((step, i) => {
      if (i !== index) {
        return step;
      }
      const next = { ...step, ...patch };
      if (patch.title !== undefined && patch.title !== step.title) {
        if (lang) {
          next.titles = { [lang]: patch.title };
        } else {
          delete next.titles;
        }
      }
      return next;
    });
  }
  steps = steps.map((step, i) => ({ ...step, after: earlier(step.after, i) }));
  host.business = { ...host.business, linkedCreate: { ...form, steps, notice: null } };
}

export function cancelBusinessLinkedCreate(host: BusinessHost) {
  if (!host.business.linkedCreate?.pending) {
    host.business = { ...host.business, linkedCreate: null };
  }
}

/**
 * Worksheet order with every prerequisite moved ahead of the steps that wait for it, keeping the
 * written order wherever the dependencies allow. Null on an unknown dependency or a cycle.
 */
function prerequisitesFirst(steps: WorkItemLinkedCase["plan"]["steps"]): number[] | null {
  const keys = steps.map((step) => step.key);
  // An unknown key (-1) is never placed, so it stops the walk like a cycle does.
  const deps = steps.map((step) => step.dependsOn.map((d) => keys.indexOf(d)));
  const order: number[] = [];
  const placed = new Set<number>();
  while (order.length < steps.length) {
    const next = deps.findIndex((after, i) => !placed.has(i) && after.every((j) => placed.has(j)));
    if (next < 0) {
      return null;
    }
    order.push(next);
    placed.add(next);
  }
  return order;
}

/**
 * A plan the form can show: only a clean worksheet plan whose dependencies all resolve without a
 * cycle. Rows are reordered so each step waits only for earlier rows; anything else is not
 * offered, because the form would drop a dependency and let a step open early. A named file that
 * is not offered comes back with the reason so the form can say so. Null without a file name.
 */
function offeredPlan(value: unknown): BusinessPackPlan | BusinessPackPlanOmission | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.file !== "string") {
    return null;
  }
  const omit = (reason: BusinessPackPlanOmission["reason"], problems: string[] = []) => ({
    file: entry.file as string,
    reason,
    problems,
  });
  if (Array.isArray(entry.problems) && entry.problems.length > 0) {
    const codes = entry.problems.map((p) =>
      p && typeof p === "object" ? (p as { code?: unknown }).code : undefined,
    );
    return omit("problems", [
      ...new Set(codes.filter((c): c is string => typeof c === "string" && c.length <= 64)),
    ]);
  }
  const steps = (entry.plan as { steps?: unknown } | null | undefined)?.steps;
  if (Array.isArray(steps) && steps.length > LINKED_CREATE_MAX_STEPS) {
    return omit("size");
  }
  if (
    !Array.isArray(entry.problems) ||
    !Array.isArray(steps) ||
    !steps.length ||
    !steps.every(renderablePlanStep)
  ) {
    return omit("unreadable");
  }
  const keys = (steps as WorkItemLinkedCase["plan"]["steps"]).map((step) => step.key);
  if (new Set(keys).size !== keys.length) {
    return omit("unreadable");
  }
  const sourceKeys =
    entry.sourceKeys && typeof entry.sourceKeys === "object"
      ? (entry.sourceKeys as Record<string, unknown>)
      : {};
  const written = steps as WorkItemLinkedCase["plan"]["steps"];
  const order = prerequisitesFirst(written);
  if (!order) {
    return omit("order");
  }
  const row = new Map(order.map((from, to) => [from, to]));
  const out: BusinessPackPlan["steps"] = [];
  for (const from of order) {
    const step = written[from];
    const source = sourceKeys[step.key];
    const after = step.dependsOn.map((d) => row.get(keys.indexOf(d))!);
    out.push({
      department: step.department,
      title: { ja: step.title.ja, en: step.title.en },
      after: [...new Set(after)].toSorted((a, b) => a - b),
      source: typeof source === "string" ? source : step.key,
    });
  }
  return { file: entry.file, steps: out };
}

/** Read-only: lists the pack worksheet plans for the open form. Nothing is installed. */
export async function loadBusinessLinkedPlans(host: BusinessHost) {
  const client = host.client;
  const item = host.business.item;
  const form = host.business.linkedCreate;
  if (!client || !host.connected || !item || !form || form.itemId !== item.id) {
    return;
  }
  const plans: BusinessPackPlan[] = [];
  const omitted: BusinessPackPlanOmission[] = [];
  try {
    const result = await client.request<{ plans?: unknown }>("workitems.linked.plans", {
      projectId: item.projectId,
      id: item.id,
    });
    for (const entry of Array.isArray(result?.plans) ? result.plans : []) {
      const read = offeredPlan(entry);
      if (read && "reason" in read) {
        omitted.push(read);
      } else if (read) {
        plans.push(read);
      }
    }
  } catch {
    // Offering a plan is optional; the person can still write the steps by hand.
  }
  const now = host.business.linkedCreate;
  if (
    host.client === client &&
    host.business.item?.id === item.id &&
    now &&
    now.itemId === item.id &&
    now.revision === form.revision &&
    !now.pending
  ) {
    host.business = { ...host.business, linkedCreate: { ...now, plans, omitted } };
  }
}

/**
 * Replaces the form's steps with an offered plan, each title in the screen language, or in the
 * worksheet's other language when that is the only one it wrote.
 */
export function applyBusinessLinkedPlan(host: BusinessHost, file: string, lang: "en" | "ja") {
  const form = host.business.linkedCreate;
  const plan = form?.plans?.find((p) => p.file === file);
  if (!form || form.pending || !plan || !withoutLinkedCase(host)) {
    return;
  }
  const other = lang === "ja" ? "en" : "ja";
  const steps = plan.steps.map((step) => ({
    department: step.department,
    title: [step.title[lang], step.title[other]].find((text) => text?.trim()) ?? "",
    after: [...step.after],
    titles: { ...step.title },
    source: step.source,
  }));
  host.business = { ...host.business, linkedCreate: { ...form, steps, notice: null } };
}

/** A prefilled step's worksheet titles, trimmed, keeping only the languages it has. */
function worksheetTitles(titles: { ja?: string; en?: string }) {
  const out: { ja?: string; en?: string } = {};
  for (const lang of ["ja", "en"] as const) {
    const text = titles[lang]?.trim();
    if (text) {
      out[lang] = text;
    }
  }
  return out;
}

/** The plan the gateway receives, or null when a step is incomplete. The gateway validates again. */
export function linkedCreatePlan(steps: BusinessLinkedCreateStep[], lang: "en" | "ja") {
  if (!steps.length || steps.length > LINKED_CREATE_MAX_STEPS) {
    return null;
  }
  const plan = steps.map((step, i) => ({
    key: `step-${i + 1}`,
    department: step.department,
    title: step.titles ? worksheetTitles(step.titles) : { [lang]: step.title.trim() },
    dependsOn: earlier(step.after, i).map((j) => `step-${j + 1}`),
  }));
  const complete = plan.every(
    (step, i) =>
      !!getBusinessDepartment(step.department) &&
      !!steps[i].title.trim() &&
      steps[i].title.trim().length <= LINKED_TITLE_MAX &&
      Object.values(step.title).every((text) => !!text && text.length <= LINKED_TITLE_MAX),
  );
  return complete ? { steps: plan } : null;
}

/** A person-confirmed write. The case is always read back from the gateway, never assumed. */
export async function submitBusinessLinkedCreate(host: BusinessHost, lang: "en" | "ja") {
  const form = host.business.linkedCreate;
  const client = host.client;
  const item = host.business.item;
  if (!form || form.pending || !client || !host.connected || !item || createInFlight.has(host)) {
    return;
  }
  const notice = (id: string) => t(id as MessageId);
  if (form.itemId !== item.id || form.revision !== item.revision || !withoutLinkedCase(host)) {
    host.business = {
      ...host.business,
      linkedCreate: { ...form, notice: notice("business.linked.create.changed") },
    };
    return;
  }
  const plan = linkedCreatePlan(form.steps, lang);
  if (!plan) {
    host.business = {
      ...host.business,
      linkedCreate: { ...form, notice: notice("business.linked.create.invalid") },
    };
    return;
  }
  const pending = { ...form, pending: true, notice: null };
  host.business = { ...host.business, linkedCreate: pending };
  createInFlight.add(host);
  let saved = false;
  let message: string;
  try {
    try {
      const result = await client.request<WorkitemsLinkedCreateResult>("workitems.linked.create", {
        projectId: item.projectId,
        id: item.id,
        plan: plan as WorkitemsLinkedCreateParams["plan"],
      } satisfies WorkitemsLinkedCreateParams);
      if (result?.linkedCase?.parentId !== item.id) {
        throw new Error("Linked case scope mismatch");
      }
      saved = true;
      message = notice("business.linked.create.saved");
    } catch (error) {
      const refusal = refusalOf(error);
      message = notice(
        refusal ? `business.linked.refusal.${refusal}` : "business.linked.create.failed",
      );
    }
  } finally {
    createInFlight.delete(host);
  }
  const still =
    host.client === client &&
    host.business.item?.id === item.id &&
    host.business.projectId === item.projectId &&
    host.business.linkedCreate === pending;
  if (!still) {
    if (host.business.linkedCreate === pending) {
      host.business = { ...host.business, linkedCreate: null };
    }
    return;
  }
  host.business = {
    ...host.business,
    // Kept after success so the notice stays; the form only renders while there is no case.
    linkedCreate: { ...pending, pending: false, notice: message, steps: saved ? [] : form.steps },
  };
  // Read back on success and on an uncertain failure alike.
  await loadBusinessLinkedCase(host, host.business.item ?? item);
}
