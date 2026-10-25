import type {
  WorkitemsConfigResult,
  WorkitemsDecideParams,
  WorkitemsDecideResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import type { Project, ProjectsState } from "./projects";
import { WORK_ITEM_DECISION_REFUSALS } from "../../../../packages/client/src/workitems";
import { getBusinessDepartment } from "../business-departments";
import { t, type MessageId } from "../i18n";
import { resetBusinessWorkState, type BusinessWorkForm } from "./business-work-intake";

export type BusinessDecisionForm = {
  id: string;
  revision: number;
  decision: WorkitemsDecideParams["decision"];
  comment: string;
  override: boolean;
  overrideReason: string;
};

export type BusinessDraftPreview = {
  itemId: string;
  revision: number;
  status: "loading" | "ready" | "error";
  content: string | null;
};

export type BusinessEvidence = {
  itemId: string;
  revision: number;
  status: "loading" | "verified" | "failed" | "unavailable";
  checkedAt: string | null;
  bundles: number;
};

export type ExpenseForm = {
  target?: { id: string; revision: number; action: "edit" | "submit" };
  queue: string;
  title: string;
  employeeId: string;
  amount: string;
  expenseDate: string;
  category: string;
  purpose: string;
  documents: string;
};

export type BusinessState = {
  workForm: BusinessWorkForm | null;
  workPending: boolean;
  workNotice: string | null;
  workUncertain: boolean;
  department: string;
  organizationMode: "enterprise" | "sme";
  search: string;
  status: "" | WorkitemsGetResult["item"]["status"];
  evidence: BusinessEvidence | null;
  draftPreview: BusinessDraftPreview | null;
  decisionForm: BusinessDecisionForm | null;
  decisionPending: boolean;
  decisionNotice: string | null;
  expenseForm: ExpenseForm | null;
  expensePending: boolean;
  expenseNotice: string | null;
  expenseUncertain: boolean;
  projectId: string | null;
  queue: string;
  config: WorkitemsConfigResult | null;
  list: WorkitemsListResult | null;
  item: WorkitemsGetResult["item"] | null;
  selectedId: string | null;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  detailError: string | null;
};
export const emptyBusiness = (): BusinessState => ({
  workForm: null,
  workPending: false,
  workNotice: null,
  workUncertain: false,
  department: "all",
  organizationMode: "enterprise",
  search: "",
  status: "",
  evidence: null,
  draftPreview: null,
  decisionForm: null,
  decisionPending: false,
  decisionNotice: null,
  expenseForm: null,
  expensePending: false,
  expenseNotice: null,
  expenseUncertain: false,
  projectId: null,
  queue: "",
  config: null,
  list: null,
  item: null,
  selectedId: null,
  loading: false,
  detailLoading: false,
  error: null,
  detailError: null,
});
export type BusinessHost = {
  business: BusinessState;
  client: GatewayBrowserClient | null;
  connected: boolean;
  tab: string;
  projects: ProjectsState;
};
const inFlightDecisions = new WeakSet<BusinessHost>();
export const inFlightBusinessExpenses = new WeakSet<BusinessHost>();
export const uncertainBusinessExpenses = new WeakMap<BusinessHost, Map<string, string>>();
const queuedEvents = new WeakMap<BusinessHost, boolean>();
const requests = new WeakMap<BusinessHost, { list: number; detail: number; decision: number }>();
function tokens(host: BusinessHost) {
  let value = requests.get(host);
  if (!value) {
    value = { list: 0, detail: 0, decision: 0 };
    requests.set(host, value);
  }
  return value;
}
function patch(host: BusinessHost, next: Partial<BusinessState>) {
  host.business = { ...host.business, ...next };
}
export function isBusinessProject(project: Project): boolean {
  return project.templateId?.startsWith("business-") === true;
}
export function resetBusiness(host: BusinessHost) {
  const pending = tokens(host);
  pending.list++;
  pending.detail++;
  pending.decision++;
  queuedEvents.delete(host);
  const projectId = host.projects?.selectedId ?? host.business?.projectId ?? "";
  const uncertain = uncertainBusinessExpenses.get(host)?.get(projectId) ?? null;
  host.business = {
    ...emptyBusiness(),
    decisionPending: inFlightDecisions.has(host),
    expensePending: inFlightBusinessExpenses.has(host),
    ...(uncertain
      ? {
          projectId,
          expenseUncertain: true,
          expenseNotice: uncertain,
        }
      : {}),
  };
  resetBusinessWorkState(host);
}
function activeProject(host: BusinessHost): string | null {
  return host.connected && host.tab === "projects" && host.projects?.view === "business"
    ? host.projects.selectedId
    : null;
}
function current(host: BusinessHost, client: GatewayBrowserClient, projectId: string) {
  return host.client === client && activeProject(host) === projectId;
}

/** Refresh after events, reconnect, or a person choosing Refresh. Events never supply item data. */
export async function loadBusiness(
  host: BusinessHost,
  more = false,
  background = false,
  refreshDetail = true,
) {
  const projectId = activeProject(host);
  const client = host.client;
  if (!projectId || !client) {
    return;
  }
  if (host.business.projectId !== projectId) {
    resetBusiness(host);
    patch(host, { projectId });
  }
  const previous = host.business;
  if (more && (previous.loading || !previous.list?.nextCursor)) {
    return;
  }
  const queue = previous.queue;
  const department = previous.department ?? "all";
  const ticket = ++tokens(host).list;
  patch(host, {
    loading: true,
    error: null,
    ...(more || background ? {} : { list: null }),
  });
  const detail =
    !more && refreshDetail && previous.selectedId
      ? loadBusinessItem(host, previous.selectedId, background)
      : Promise.resolve();
  try {
    const fetchList = (selectedQueue: string, paginate: boolean) =>
      client.request<WorkitemsListResult>("workitems.list", {
        projectId,
        ...(selectedQueue ? { queue: selectedQueue } : {}),
        ...(department !== "all" ? { department } : {}),
        ...(previous.search ? { q: previous.search } : {}),
        ...(previous.status ? { status: previous.status } : {}),
        limit: background ? Math.min(200, Math.max(50, previous.list?.items.length ?? 0)) : 50,
        ...(paginate ? { cursor: previous.list!.nextCursor } : {}),
      });
    const [config, initialList] = await Promise.all([
      client.request<WorkitemsConfigResult>("workitems.config", { projectId }),
      fetchList(queue, more),
    ]);
    if (!current(host, client, projectId) || tokens(host).list !== ticket) {
      return;
    }
    let list: WorkitemsListResult | null = initialList;
    let sameQueue = true;
    if (department !== "all") {
      // Match the server contract: absent metadata is unmapped, never inferred from a template.
      const available = config.error
        ? []
        : config.queues.filter((candidate) => (candidate.department ?? "unmapped") === department);
      const nextQueue = available.some((candidate) => candidate.id === queue) ? queue : "";
      const previousQueues = (previous.config?.queues ?? [])
        .filter((candidate) => (candidate.department ?? "unmapped") === department)
        .map((candidate) => candidate.id);
      const membershipChanged =
        previousQueues.length !== available.length ||
        available.some((candidate) => !previousQueues.includes(candidate.id));
      sameQueue = nextQueue === queue && !membershipChanged;
      const detailOutOfScope =
        previous.item && !available.some((candidate) => candidate.id === previous.item!.queue);
      if (!sameQueue || detailOutOfScope || config.error) {
        tokens(host).detail++;
        clearDecision(host);
        patch(host, {
          queue: nextQueue,
          item: null,
          selectedId: null,
          detailLoading: false,
          detailError: null,
          draftPreview: null,
          evidence: null,
        });
      }
      if (config.error) {
        list = null;
      } else if (nextQueue !== queue || (more && membershipChanged)) {
        list = await fetchList(nextQueue, false);
        if (!current(host, client, projectId) || tokens(host).list !== ticket) {
          return;
        }
      }
    }
    const items =
      list && more && sameQueue
        ? [
            ...new Map(
              [...(previous.list?.items ?? []), ...list.items].map((item) => [item.id, item]),
            ).values(),
          ]
        : (list?.items ?? []);
    patch(host, { config, list: list ? { ...list, items } : null, loading: false });
  } catch {
    if (current(host, client, projectId) && tokens(host).list === ticket) {
      patch(host, { loading: false, list: null, config: null, error: t("business.loadError") });
    }
  }
  await detail;
  if (current(host, client, projectId) && tokens(host).list === ticket && queuedEvents.has(host)) {
    const refreshSelected = queuedEvents.get(host)!;
    queuedEvents.delete(host);
    void loadBusiness(host, false, true, refreshSelected);
  }
}
export async function selectBusinessQueue(host: BusinessHost, queue: string) {
  if (!activeProject(host) || host.business.workPending || host.business.workForm) {
    return;
  }
  if (queue && (host.business.department ?? "all") !== "all") {
    const candidate = host.business.config?.queues.find((value) => value.id === queue);
    if (!candidate || (candidate.department ?? "unmapped") !== host.business.department) {
      return;
    }
  }
  tokens(host).detail++;
  clearDecision(host);
  patch(host, {
    evidence: null,
    draftPreview: null,
    queue,
    selectedId: null,
    item: null,
    detailLoading: false,
    detailError: null,
  });
  await loadBusiness(host);
}

/** Department selection is navigation; gateway authorization remains authoritative. */
export async function selectBusinessDepartment(host: BusinessHost, department: string) {
  if (
    !activeProject(host) ||
    host.business.projectId !== activeProject(host) ||
    (department !== "all" && department !== "unmapped" && !getBusinessDepartment(department)) ||
    host.business.decisionPending ||
    host.business.expensePending ||
    host.business.expenseForm ||
    host.business.decisionForm ||
    host.business.workPending ||
    host.business.workForm
  ) {
    return;
  }
  tokens(host).list++;
  tokens(host).detail++;
  clearDecision(host);
  patch(host, {
    department,
    queue: "",
    search: "",
    status: "",
    list: null,
    item: null,
    selectedId: null,
    evidence: null,
    draftPreview: null,
    detailLoading: false,
    detailError: null,
  });
  await loadBusiness(host);
}

export function setBusinessOrganizationMode(host: BusinessHost, mode: "enterprise" | "sme") {
  if (mode === "enterprise" || mode === "sme") {
    patch(host, { organizationMode: mode });
  }
}

export async function filterBusiness(
  host: BusinessHost,
  search: string,
  status: BusinessState["status"],
) {
  if (
    !activeProject(host) ||
    host.business.decisionPending ||
    host.business.expensePending ||
    host.business.expenseForm ||
    host.business.decisionForm ||
    host.business.workPending ||
    host.business.workForm
  ) {
    return;
  }
  const statuses = [
    "",
    "new",
    "drafting",
    "awaiting_review",
    "approved",
    "sent_back",
    "done",
    "cancelled",
  ];
  if (!statuses.includes(status)) {
    return;
  }
  tokens(host).detail++;
  clearDecision(host);
  patch(host, {
    search: search.trim().slice(0, 200),
    status,
    selectedId: null,
    item: null,
    evidence: null,
    draftPreview: null,
    detailLoading: false,
    detailError: null,
  });
  await loadBusiness(host);
}
export async function loadBusinessItem(host: BusinessHost, id: string, background = false) {
  const projectId = activeProject(host);
  const client = host.client;
  if (!projectId || !client) {
    return;
  }
  if (
    (!background || host.business.selectedId !== id) &&
    !(host.business.decisionPending && host.business.selectedId === id)
  ) {
    clearDecision(host);
  }
  const ticket = ++tokens(host).detail;
  patch(host, {
    selectedId: id,
    evidence: null,
    draftPreview: null,
    ...(background && host.business.item?.id === id ? {} : { item: null }),
    detailLoading: true,
    detailError: null,
  });
  try {
    const { item } = await client.request<WorkitemsGetResult>("workitems.get", { projectId, id });
    if (!current(host, client, projectId) || tokens(host).detail !== ticket) {
      return;
    }
    if (item.projectId !== projectId || item.id !== id) {
      throw new Error("Item scope mismatch");
    }
    const form = host.business.decisionForm;
    const changed = form && (form.id !== item.id || form.revision !== item.revision);
    patch(host, {
      item,
      detailLoading: false,
      ...(changed
        ? { decisionForm: null, decisionNotice: t("business.decision.changed" as MessageId) }
        : {}),
    });
  } catch {
    if (current(host, client, projectId) && tokens(host).detail === ticket) {
      patch(host, { item: null, detailLoading: false, detailError: t("business.detailError") });
    }
  }
}
export function businessEvent(host: BusinessHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if ((payload as { projectId?: unknown }).projectId === activeProject(host)) {
    const refreshSelected = (payload as { id?: unknown }).id === host.business.selectedId;
    if (host.business.loading) {
      queuedEvents.set(host, (queuedEvents.get(host) ?? false) || refreshSelected);
    } else {
      void loadBusiness(host, false, true, refreshSelected);
    }
  }
}

function clearDecision(host: BusinessHost) {
  tokens(host).decision++;
  patch(host, {
    decisionForm: null,
    decisionPending: inFlightDecisions.has(host),
    decisionNotice: null,
  });
}
function canDecide(host: BusinessHost) {
  const state = host.business;
  return (
    activeProject(host) === state.projectId &&
    state.projectId !== null &&
    state.item?.projectId === state.projectId &&
    state.item.id === state.selectedId &&
    !!state.config &&
    !state.config.error &&
    !state.loading &&
    !state.detailLoading &&
    !state.detailError &&
    !state.decisionPending &&
    !state.expensePending &&
    !state.expenseForm &&
    !state.expenseUncertain &&
    !state.workPending &&
    !state.workForm &&
    !state.workUncertain &&
    !inFlightBusinessExpenses.has(host) &&
    !inFlightDecisions.has(host)
  );
}
export function beginBusinessDecision(
  host: BusinessHost,
  decision: BusinessDecisionForm["decision"],
) {
  if (!canDecide(host)) {
    return;
  }
  const item = host.business.item!;
  if (
    item.status === "done" ||
    item.status === "cancelled" ||
    (decision !== "cancel" && item.status !== "awaiting_review")
  ) {
    return;
  }
  patch(host, {
    decisionNotice: null,
    decisionForm: {
      id: item.id,
      revision: item.revision,
      decision,
      comment: "",
      override: false,
      overrideReason: "",
    },
  });
}
export function editBusinessDecision(
  host: BusinessHost,
  update: Partial<Pick<BusinessDecisionForm, "comment" | "override" | "overrideReason">>,
) {
  const form = host.business.decisionForm;
  if (!form || host.business.decisionPending) {
    return;
  }
  // Copy editable fields explicitly; item scope, action and revision are pinned by Begin.
  patch(host, {
    decisionForm: {
      ...form,
      comment: update.comment ?? form.comment,
      override: update.override ?? form.override,
      overrideReason: update.overrideReason ?? form.overrideReason,
    },
  });
}
export function cancelBusinessDecision(host: BusinessHost) {
  if (!host.business.decisionPending) {
    clearDecision(host);
  }
}
function decisionFailure(error: unknown): string {
  const details = error && typeof error === "object" && "details" in error ? error.details : null;
  const code = details && typeof details === "object" && "code" in details ? details.code : null;
  const known = WORK_ITEM_DECISION_REFUSALS.find((value) => value === code);
  return t(
    (known ? `business.decision.refusal.${known}` : "business.decision.unknown") as MessageId,
  );
}
/** Called only from the explicit review form. Never replay a decision after an event or refusal. */
export async function submitBusinessDecision(host: BusinessHost) {
  const form = host.business.decisionForm;
  const client = host.client;
  if (!form || !client || !canDecide(host)) {
    return;
  }
  const item = host.business.item!;
  if (form.id !== item.id || form.revision !== item.revision) {
    patch(host, {
      decisionForm: null,
      decisionNotice: t("business.decision.changed" as MessageId),
    });
    return;
  }
  if (
    item.status === "done" ||
    item.status === "cancelled" ||
    (form.decision !== "cancel" && item.status !== "awaiting_review")
  ) {
    return;
  }
  const comment = form.comment.trim();
  const reason = form.overrideReason.trim();
  if (
    comment.length > 2000 ||
    (form.decision !== "approve" && !comment) ||
    (form.override && (form.decision !== "approve" || reason.length < 10 || reason.length > 2000))
  ) {
    return;
  }
  const projectId = item.projectId;
  const ticket = ++tokens(host).decision;
  const stillCurrent = () =>
    current(host, client, projectId) &&
    host.business.selectedId === item.id &&
    tokens(host).decision === ticket;
  inFlightDecisions.add(host);
  patch(host, { decisionPending: true, decisionNotice: null });
  try {
    let notice: string;
    try {
      const result = await client.request<WorkitemsDecideResult>("workitems.decide", {
        projectId,
        id: form.id,
        expectedRevision: form.revision,
        decision: form.decision,
        ...(comment ? { comment } : {}),
        ...(form.override ? { override: { reason } } : {}),
      } satisfies WorkitemsDecideParams);
      if (result.item.projectId !== projectId || result.item.id !== form.id) {
        throw new Error("Item scope mismatch");
      }
      notice = t("business.decision.saved" as MessageId);
    } catch (error) {
      notice = decisionFailure(error);
    }
    if (!stillCurrent()) {
      return;
    }
    // Read back on both success and uncertain failure. Never optimistically mark an item approved.
    patch(host, { decisionForm: null, decisionNotice: notice });
    await loadBusiness(host, false, true);
  } finally {
    // The transport owns this lock: navigation and refresh cannot release an unresolved write.
    inFlightDecisions.delete(host);
    patch(host, { decisionPending: false });
  }
}
