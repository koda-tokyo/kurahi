import type {
  AutopilotReportErrorParams,
  AutopilotReportErrorResult,
  AutopilotAutonomyProposalsResult,
  AutopilotBriefGetResult,
  AutopilotAutonomyAcceptParams,
  AutopilotAutonomyAcceptResult,
  AutopilotAutonomyDeclineResult,
  AutopilotRoutinesListResult,
  AutopilotRunsGetResult,
  AutopilotRunsListResult,
  AutopilotRunsListParams,
  AutopilotStatsResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayHelloOk, GatewayBrowserClient } from "../gateway";
import type { ProjectsState } from "./projects";

export type AutopilotFilters = Pick<AutopilotRunsListParams, "edition" | "area">;

// Optional metadata keeps the console compatible with older gateways.
export type AutopilotBrief = AutopilotBriefGetResult["brief"] & {
  truncated?: {
    documents: boolean;
    decisions: boolean;
    flagged: boolean;
    commitments: boolean;
    linked?: boolean;
  };
};

// Optional until all gateways and generated clients expose retention receipts.
export type AutopilotRunDetail = AutopilotRunsGetResult & {
  evidence: AutopilotRunsGetResult["evidence"] & { tombstone?: boolean };
};

export type AutopilotState = {
  mutationDelayed: boolean;
  reportReasons: Record<string, string>;
  reportPending: string | null;
  reportStatus: "reportSaved" | "reportChanged" | "reportFailed" | "reportInvalid" | null;
  routineReasons: Record<string, string>;
  routinePending: string | null;
  routineStatus:
    | "routinePaused"
    | "routineResumed"
    | "routineChanged"
    | "routineReasonRequired"
    | "routineStopped"
    | "routineFailed"
    | "routineInvalid"
    | null;
  filters: AutopilotFilters;
  projectId: string | null;
  cursor: string | null;
  loading: boolean;
  error: boolean;
  routines: AutopilotRoutinesListResult | null;
  runs: AutopilotRunsListResult | null;
  stats: AutopilotStatsResult | null;
  autonomy: AutopilotAutonomyProposalsResult | null;
  autonomyError: boolean;
  brief: AutopilotBrief | null;
  briefError: boolean;
  declineReasons: Record<string, string>;
  acceptPending: string | null;
  acceptStatus: "acceptSaved" | "acceptChanged" | "acceptFailed" | "acceptInvalid" | null;
  declinePending: string | null;
  declineStatus: "declineSaved" | "declineChanged" | "declineFailed" | "declineInvalid" | null;
  linkedRun: { id: string; itemId: string } | null;
  selectedRunId: string | null;
  runLoading: boolean;
  runError: boolean;
  runDetail: AutopilotRunDetail | null;
};
export const emptyAutopilot = (): AutopilotState => ({
  mutationDelayed: false,
  reportReasons: {},
  reportPending: null,
  reportStatus: null,
  routineReasons: {},
  routinePending: null,
  routineStatus: null,
  filters: {},
  projectId: null,
  cursor: null,
  loading: false,
  error: false,
  routines: null,
  runs: null,
  stats: null,
  autonomy: null,
  autonomyError: false,
  brief: null,
  briefError: false,
  declineReasons: {},
  acceptPending: null,
  acceptStatus: null,
  declinePending: null,
  declineStatus: null,
  linkedRun: null,
  selectedRunId: null,
  runLoading: false,
  runError: false,
  runDetail: null,
});
export type AutopilotHost = {
  autopilot: AutopilotState;
  hello?: GatewayHelloOk | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  tab: string;
  projects: ProjectsState;
};
const generations = new WeakMap<AutopilotHost, number>();
const queued = new WeakSet<AutopilotHost>();
export function resetAutopilot(host: AutopilotHost) {
  generations.set(host, (generations.get(host) ?? 0) + 1);
  queued.delete(host);
  // Navigation invalidates display state, not an unresolved transport write.
  host.autopilot = { ...emptyAutopilot(), mutationDelayed: mutations.get(host)?.delayed ?? false };
}
function active(host: AutopilotHost) {
  return host.connected && host.tab === "projects" && host.projects?.view === "autopilot"
    ? host.projects.selectedId
    : null;
}
export async function loadAutopilot(host: AutopilotHost, cursor?: string) {
  const projectId = active(host);
  const client = host.client;
  if (!projectId || !client) {
    return;
  }
  const pending = mutations.get(host);
  if (pending) {
    queued.add(host);
    if (
      pending.projectId !== projectId ||
      pending.client !== client ||
      host.autopilot.projectId !== projectId ||
      !host.autopilot.routines
    ) {
      // Do not show another scope's data while its write still owns the transport lock.
      generations.set(host, (generations.get(host) ?? 0) + 1);
      const sameProject = host.autopilot.projectId === projectId;
      host.autopilot = {
        ...emptyAutopilot(),
        projectId,
        mutationDelayed: pending.delayed,
        loading: true,
        filters: sameProject ? host.autopilot.filters : {},
        linkedRun: sameProject ? host.autopilot.linkedRun : null,
        selectedRunId: sameProject ? host.autopilot.selectedRunId : null,
      };
    }
    return;
  }
  const sameProject = host.autopilot.projectId === projectId;
  const routineReasons = sameProject ? host.autopilot.routineReasons : {};
  const reportReasons = sameProject ? host.autopilot.reportReasons : {};
  const declineReasons = sameProject ? host.autopilot.declineReasons : {};
  const filters = sameProject ? { ...host.autopilot.filters } : {};
  const previousRoutines = sameProject ? host.autopilot.routines : null;
  const linkedRun = sameProject ? host.autopilot.linkedRun : null;
  const selectedRunId = sameProject ? host.autopilot.selectedRunId : null;
  const selectionTicket = runGenerations.get(host);
  const ticket = (generations.get(host) ?? 0) + 1;
  generations.set(host, ticket);
  queued.delete(host);
  host.autopilot = {
    ...emptyAutopilot(),
    projectId,
    routineReasons,
    declineReasons,
    reportReasons,
    filters,
    routines: previousRoutines,
    selectedRunId,
    linkedRun,
    cursor: cursor ?? null,
    loading: true,
  };
  const runsParams: AutopilotRunsListParams = {
    projectId,
    limit: 20,
    ...filters,
    ...(cursor ? { cursor } : {}),
  };
  const current = () =>
    active(host) === projectId && host.client === client && generations.get(host) === ticket;
  try {
    const [routines, runs, stats, autonomy, briefResult] = await Promise.all([
      client.request<AutopilotRoutinesListResult>("autopilot.routines.list", { projectId }),
      client.request<AutopilotRunsListResult>("autopilot.runs.list", runsParams),
      client.request<AutopilotStatsResult>("autopilot.stats", { projectId }),
      // Older gateways may not expose proposals yet. Their absence must not hide run evidence.
      client
        .request<AutopilotAutonomyProposalsResult>("autopilot.autonomy.proposals", { projectId })
        .catch(() => null),
      // Caller identity is derived by the gateway; never send a principal selector.
      client
        .request<AutopilotBriefGetResult>("autopilot.brief.get", { projectId })
        .catch(() => null),
    ]);
    if (!current()) {
      return;
    }
    host.autopilot = {
      ...emptyAutopilot(),
      projectId,
      routineReasons,
      declineReasons,
      reportReasons,
      filters,
      cursor: cursor ?? null,
      loading: false,
      error: false,
      routines,
      runs,
      stats,
      autonomy,
      autonomyError: autonomy === null,
      brief: briefResult?.brief?.projectId === projectId ? briefResult.brief : null,
      briefError: briefResult?.brief?.projectId !== projectId,
      linkedRun,
      selectedRunId:
        runGenerations.get(host) === selectionTicket &&
        (linkedRun?.id === selectedRunId || runs.runs.some((run) => run.id === selectedRunId))
          ? selectedRunId
          : null,
    };
  } catch {
    if (!current()) {
      return;
    }
    host.autopilot = {
      ...emptyAutopilot(),
      projectId,
      filters,
      routineReasons,
      declineReasons,
      reportReasons,
      error: true,
    };
  }
  if (current() && queued.has(host)) {
    queued.delete(host);
    await loadAutopilot(host);
  } else if (current() && host.autopilot.selectedRunId) {
    await inspectAutopilotRun(host, host.autopilot.selectedRunId);
  }
}
/** Changing scope always returns to the first page and supersedes in-flight reads. */
export async function setAutopilotFilters(host: AutopilotHost, filters: AutopilotFilters) {
  const projectId = active(host);
  if (!projectId) {
    return;
  }
  closeAutopilotRun(host);
  const next: AutopilotFilters = {
    ...(filters.edition ? { edition: filters.edition } : {}),
    ...(filters.area ? { area: filters.area } : {}),
  };
  host.autopilot = {
    ...(host.autopilot.projectId === projectId ? host.autopilot : emptyAutopilot()),
    projectId,
    filters: next,
    cursor: null,
  };
  await loadAutopilot(host);
}
/** Events invalidate data; only read RPC responses supply display values. */
export function autopilotEvent(host: AutopilotHost, payload: unknown) {
  if (!active(host) || !payload || typeof payload !== "object") {
    return;
  }
  if ((payload as { projectId?: unknown }).projectId !== active(host)) {
    return;
  }
  if (host.autopilot?.loading) {
    queued.add(host);
  } else {
    void loadAutopilot(host);
  }
}

const runGenerations = new WeakMap<AutopilotHost, number>();
export function closeAutopilotRun(host: AutopilotHost) {
  runGenerations.set(host, (runGenerations.get(host) ?? 0) + 1);
  host.autopilot = {
    ...host.autopilot,
    linkedRun: null,
    selectedRunId: null,
    runLoading: false,
    runError: false,
    runDetail: null,
    reportReasons: {},
    reportStatus: null,
  };
}
/** Inspect a loaded run or an explicit Business item link, within the selected Project. */
export async function inspectAutopilotRun(host: AutopilotHost, id: string) {
  const projectId = active(host);
  const client = host.client;
  if (
    !projectId ||
    !client ||
    host.autopilot.projectId !== projectId ||
    host.autopilot.loading ||
    (host.autopilot.linkedRun?.id !== id && !host.autopilot.runs?.runs.some((run) => run.id === id))
  ) {
    return;
  }
  const linkedItemId = host.autopilot.linkedRun?.id === id ? host.autopilot.linkedRun.itemId : null;
  const pageTicket = generations.get(host);
  const ticket = (runGenerations.get(host) ?? 0) + 1;
  runGenerations.set(host, ticket);
  host.autopilot = {
    ...host.autopilot,
    reportReasons: host.autopilot.selectedRunId === id ? host.autopilot.reportReasons : {},
    reportStatus: null,
    selectedRunId: id,
    runLoading: true,
    runError: false,
    runDetail: null,
  };
  const current = () =>
    active(host) === projectId &&
    host.client === client &&
    generations.get(host) === pageTicket &&
    runGenerations.get(host) === ticket &&
    host.autopilot.selectedRunId === id;
  try {
    const detail = await client.request<AutopilotRunDetail>("autopilot.runs.get", {
      projectId,
      id,
    });
    if (!current()) {
      return;
    }
    if (
      detail.run.id !== id ||
      detail.run.projectId !== projectId ||
      (linkedItemId && !detail.run.workItems.includes(linkedItemId))
    ) {
      throw new Error("Run scope mismatch");
    }
    host.autopilot = { ...host.autopilot, runLoading: false, runDetail: detail };
  } catch {
    if (!current()) {
      return;
    }
    host.autopilot = { ...host.autopilot, runLoading: false, runError: true, runDetail: null };
  }
}

type AutopilotMutation = {
  projectId: string;
  client: GatewayBrowserClient;
  delayed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
const mutations = new WeakMap<AutopilotHost, AutopilotMutation>();
function beginMutation(host: AutopilotHost, projectId: string, client: GatewayBrowserClient) {
  const mutation: AutopilotMutation = { projectId, client, delayed: false, timer: null };
  mutations.set(host, mutation);
  // This is a notice, not a request timeout: elapsed time cannot settle an uncertain write.
  mutation.timer = setTimeout(() => {
    if (mutations.get(host) !== mutation) {
      return;
    }
    mutation.delayed = true;
    host.autopilot = { ...host.autopilot, mutationDelayed: true };
  }, 30_000);
  return mutation;
}
function finishMutation(host: AutopilotHost, mutation: AutopilotMutation) {
  if (mutations.get(host) !== mutation) {
    return;
  }
  if (mutation.timer !== null) {
    clearTimeout(mutation.timer);
  }
  mutations.delete(host);
  if (host.autopilot.mutationDelayed) {
    host.autopilot = { ...host.autopilot, mutationDelayed: false };
  }
}

/** Only settlement releases a write; navigation may have queued a read for a new scope. */
async function settleStaleMutation(host: AutopilotHost, mutation: AutopilotMutation) {
  if (mutations.get(host) !== mutation) {
    return;
  }
  finishMutation(host, mutation);
  if (queued.has(host)) {
    await loadAutopilot(host);
  }
}
/** UI capability only; the gateway authenticates the person and checks approval scopes. */
export function canDeclineAutonomy(host: Pick<AutopilotHost, "hello">): boolean {
  const auth = host.hello?.auth;
  return (
    auth?.role === "operator" &&
    !!auth.scopes?.some((scope) => scope === "operator.approvals" || scope === "operator.admin")
  );
}
export const canAcceptAutonomy = canDeclineAutonomy;
export function setAutonomyDeclineReason(host: AutopilotHost, routineId: string, reason: string) {
  if (host.autopilot.projectId !== active(host) || mutations.has(host)) {
    return;
  }
  host.autopilot = {
    ...host.autopilot,
    declineReasons: { ...host.autopilot.declineReasons, [routineId]: reason },
    declineStatus: null,
    acceptStatus: null,
  };
}
export async function declineAutonomy(host: AutopilotHost, routineId: string) {
  const projectId = active(host);
  const client = host.client;
  const a = host.autopilot;
  if (
    !projectId ||
    !client ||
    !canDeclineAutonomy(host) ||
    a.projectId !== projectId ||
    a.loading ||
    mutations.has(host)
  ) {
    return;
  }
  const proposal = a.autonomy?.proposals.find((entry) => entry.routineId === routineId);
  if (!proposal || proposal.kind === "hold" || proposal.declined) {
    return;
  }
  const reason = (a.declineReasons[routineId] ?? "").trim();
  if (reason.length < 4 || reason.length > 1000) {
    host.autopilot = { ...a, declineStatus: "declineInvalid" };
    return;
  }
  const mutation = beginMutation(host, projectId, client);
  const ticket = generations.get(host);
  const current = () =>
    active(host) === projectId &&
    host.client === client &&
    generations.get(host) === ticket &&
    mutations.get(host) === mutation;
  host.autopilot = { ...a, declinePending: routineId, declineStatus: null };
  let status: AutopilotState["declineStatus"] = "declineSaved";
  let reload = true;
  try {
    await client.request<AutopilotAutonomyDeclineResult>("autopilot.autonomy.decline", {
      projectId,
      routineId,
      kind: proposal.kind,
      proposed: proposal.proposed,
      reason,
    });
  } catch (error) {
    const code = (error as { details?: { code?: string } })?.details?.code;
    reload = code === "proposal_changed" || code === "nothing_to_decline";
    status = reload ? "declineChanged" : "declineFailed";
  }
  if (!current()) {
    await settleStaleMutation(host, mutation);
    return;
  }
  finishMutation(host, mutation);
  host.autopilot = {
    ...host.autopilot,
    declinePending: null,
    declineStatus: status,
    declineReasons:
      status === "declineSaved"
        ? { ...host.autopilot.declineReasons, [routineId]: "" }
        : host.autopilot.declineReasons,
  };
  if (reload || queued.has(host)) {
    const refresh = loadAutopilot(host);
    const refreshTicket = generations.get(host);
    await refresh;
    if (
      active(host) === projectId &&
      host.client === client &&
      generations.get(host) === refreshTicket
    ) {
      host.autopilot = { ...host.autopilot, declineStatus: status };
    }
  }
}

/** Accept applies only the displayed, eligible proposal after an explicit person action. */
export async function acceptAutonomy(host: AutopilotHost, routineId: string) {
  const projectId = active(host);
  const client = host.client;
  const a = host.autopilot;
  if (
    !projectId ||
    !client ||
    !canAcceptAutonomy(host) ||
    a.projectId !== projectId ||
    a.loading ||
    mutations.has(host)
  ) {
    return;
  }
  const proposal = a.autonomy?.proposals.find((entry) => entry.routineId === routineId);
  if (
    !proposal ||
    (proposal.kind !== "promote" && proposal.kind !== "demote") ||
    proposal.declined ||
    proposal.acceptBlocker !== null
  ) {
    return;
  }
  const reason = (a.declineReasons[routineId] ?? "").trim();
  if (reason.length < 4 || reason.length > 1000) {
    host.autopilot = { ...a, acceptStatus: "acceptInvalid" };
    return;
  }
  const mutation = beginMutation(host, projectId, client);
  const ticket = generations.get(host);
  const current = () =>
    active(host) === projectId &&
    host.client === client &&
    generations.get(host) === ticket &&
    mutations.get(host) === mutation;
  host.autopilot = { ...a, acceptPending: routineId, acceptStatus: null };
  let status: AutopilotState["acceptStatus"] = "acceptSaved";
  let reload = true;
  try {
    const params: AutopilotAutonomyAcceptParams = {
      projectId,
      routineId,
      kind: proposal.kind,
      proposed: proposal.proposed,
      reason,
    };
    await client.request<AutopilotAutonomyAcceptResult>("autopilot.autonomy.accept", params);
  } catch (error) {
    const code = (error as { details?: { code?: string } })?.details?.code;
    reload = [
      "proposal_changed",
      "nothing_to_accept",
      "above_file_level",
      "no_standing_approval",
    ].includes(code ?? "");
    status = reload ? "acceptChanged" : "acceptFailed";
  }
  if (!current()) {
    await settleStaleMutation(host, mutation);
    return;
  }
  finishMutation(host, mutation);
  host.autopilot = {
    ...host.autopilot,
    acceptPending: null,
    acceptStatus: status,
    declineReasons:
      status === "acceptSaved"
        ? { ...host.autopilot.declineReasons, [routineId]: "" }
        : host.autopilot.declineReasons,
  };
  if (reload || queued.has(host)) {
    const refresh = loadAutopilot(host, host.autopilot.cursor ?? undefined);
    const refreshTicket = generations.get(host);
    await refresh;
    if (
      active(host) === projectId &&
      host.client === client &&
      generations.get(host) === refreshTicket
    ) {
      host.autopilot = { ...host.autopilot, acceptStatus: status };
    }
  }
}

/** Pause/resume shares the proposal mutation lock so events cannot invalidate an uncertain write. */
export function setAutopilotRoutineReason(host: AutopilotHost, routineId: string, reason: string) {
  if (host.autopilot.projectId !== active(host) || mutations.has(host)) {
    return;
  }
  host.autopilot = {
    ...host.autopilot,
    routineReasons: { ...host.autopilot.routineReasons, [routineId]: reason },
    routineStatus: null,
  };
}
export function routineReasonMinimum(paused: boolean, pausedBy: string | null): number {
  return !paused ? 1 : pausedBy === "watchdog" || pausedBy === "stopAll" ? 4 : 0;
}
export async function changeAutopilotRoutine(
  host: AutopilotHost,
  routineId: string,
  action: "pause" | "resume",
) {
  const projectId = active(host);
  const client = host.client;
  const a = host.autopilot;
  if (
    !projectId ||
    !client ||
    !canDeclineAutonomy(host) ||
    a.projectId !== projectId ||
    a.loading ||
    mutations.has(host)
  ) {
    return;
  }
  const routine = a.routines?.routines.find((entry) => entry.id === routineId);
  if (!routine || routine.state.paused !== (action === "resume")) {
    return;
  }
  if (action === "resume" && (a.routines?.control.stopped || a.routines?.control.emergencyStop)) {
    host.autopilot = { ...a, routineStatus: "routineStopped" };
    return;
  }
  const reason = (a.routineReasons[routineId] ?? "").trim();
  if (
    reason.length < routineReasonMinimum(routine.state.paused, routine.state.pausedBy) ||
    reason.length > 1000
  ) {
    host.autopilot = { ...a, routineStatus: "routineInvalid" };
    return;
  }
  const mutation = beginMutation(host, projectId, client);
  const ticket = generations.get(host);
  const current = () =>
    active(host) === projectId &&
    host.client === client &&
    generations.get(host) === ticket &&
    mutations.get(host) === mutation;
  host.autopilot = { ...a, routinePending: routineId, routineStatus: null };
  let status: AutopilotState["routineStatus"] =
    action === "pause" ? "routinePaused" : "routineResumed";
  let reload = true;
  let saved = true;
  try {
    await client.request(`autopilot.${action}`, {
      projectId,
      routineId,
      ...(reason || action === "pause" ? { reason } : {}),
    });
  } catch (error) {
    saved = false;
    const code = (error as { details?: { code?: string } })?.details?.code;
    reload = [
      "already_paused",
      "not_paused",
      "reason_required",
      "stopped_all",
      "emergency_stop",
    ].includes(code ?? "");
    status =
      code === "reason_required"
        ? "routineReasonRequired"
        : code === "stopped_all" || code === "emergency_stop"
          ? "routineStopped"
          : reload
            ? "routineChanged"
            : "routineFailed";
  }
  if (!current()) {
    await settleStaleMutation(host, mutation);
    return;
  }
  finishMutation(host, mutation);
  host.autopilot = {
    ...host.autopilot,
    routinePending: null,
    routineStatus: status,
    routineReasons: saved
      ? { ...host.autopilot.routineReasons, [routineId]: "" }
      : host.autopilot.routineReasons,
  };
  if (reload || queued.has(host)) {
    // Keep the selected history page so its inspected evidence survives the refresh.
    const refresh = loadAutopilot(host, host.autopilot.cursor ?? undefined);
    const refreshTicket = generations.get(host);
    await refresh;
    if (
      active(host) === projectId &&
      host.client === client &&
      generations.get(host) === refreshTicket
    ) {
      host.autopilot = { ...host.autopilot, routineStatus: status };
    }
  }
}

export function setAutopilotReportReason(host: AutopilotHost, itemId: string, reason: string) {
  if (host.autopilot.projectId !== active(host) || mutations.has(host)) {
    return;
  }
  host.autopilot = {
    ...host.autopilot,
    reportReasons: { ...host.autopilot.reportReasons, [itemId]: reason },
    reportStatus: null,
  };
}

/** Report only an item in the inspected run, following an explicit person action. */
export async function reportAutopilotError(host: AutopilotHost, itemId: string) {
  const projectId = active(host);
  const client = host.client;
  const a = host.autopilot;
  if (
    !projectId ||
    !client ||
    !canDeclineAutonomy(host) ||
    a.projectId !== projectId ||
    a.loading ||
    a.runLoading ||
    a.runError ||
    mutations.has(host) ||
    a.runDetail?.run.projectId !== projectId ||
    a.runDetail.run.id !== a.selectedRunId ||
    !a.runDetail.run.workItems.includes(itemId)
  ) {
    return;
  }
  const reason = (a.reportReasons[itemId] ?? "").trim();
  if (reason.length < 4 || reason.length > 1000) {
    host.autopilot = { ...a, reportStatus: "reportInvalid" };
    return;
  }
  const mutation = beginMutation(host, projectId, client);
  const ticket = generations.get(host);
  const runTicket = runGenerations.get(host);
  const runId = a.selectedRunId;
  const sameRun = () =>
    host.autopilot.selectedRunId === runId && runGenerations.get(host) === runTicket;
  const current = () =>
    active(host) === projectId &&
    host.client === client &&
    generations.get(host) === ticket &&
    mutations.get(host) === mutation;
  host.autopilot = { ...a, reportPending: itemId, reportStatus: null };
  let status: AutopilotState["reportStatus"] = "reportSaved";
  let reload = true;
  try {
    const params: AutopilotReportErrorParams = { projectId, itemId, reason };
    await client.request<AutopilotReportErrorResult>("autopilot.reportError", params);
  } catch (error) {
    const code = (error as { details?: { code?: string } })?.details?.code;
    reload = [
      "already_reported",
      "item_not_found",
      "not_autopilot_item",
      "routine_not_found",
      "archived",
    ].includes(code ?? "");
    status = reload ? "reportChanged" : "reportFailed";
  }
  if (!current()) {
    await settleStaleMutation(host, mutation);
    return;
  }
  finishMutation(host, mutation);
  host.autopilot = {
    ...host.autopilot,
    reportPending: null,
    reportStatus: sameRun() ? status : null,
    reportReasons:
      sameRun() && status === "reportSaved"
        ? { ...host.autopilot.reportReasons, [itemId]: "" }
        : host.autopilot.reportReasons,
  };
  if (reload || queued.has(host)) {
    const showStatus = sameRun();
    const refresh = loadAutopilot(host, host.autopilot.cursor ?? undefined);
    const refreshTicket = generations.get(host);
    await refresh;
    if (
      active(host) === projectId &&
      host.client === client &&
      generations.get(host) === refreshTicket &&
      showStatus &&
      host.autopilot.selectedRunId === runId &&
      // loadAutopilot re-inspects the retained run once. Any extra selection change
      // (including closing and reopening this run) invalidates the report status.
      runGenerations.get(host) === (runTicket ?? 0) + 1
    ) {
      host.autopilot = { ...host.autopilot, reportStatus: status };
    }
  }
}
