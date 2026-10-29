import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutopilotAutonomyProposalsResult,
  AutopilotRoutinesListResult,
  AutopilotRunsGetResult,
  AutopilotRunsListResult,
  AutopilotStatsResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import {
  reportAutopilotError,
  setAutopilotReportReason,
  changeAutopilotRoutine,
  setAutopilotRoutineReason,
  autopilotEvent,
  declineAutonomy,
  acceptAutonomy,
  canAcceptAutonomy,
  canDeclineAutonomy,
  setAutonomyDeclineReason,
  closeAutopilotRun,
  inspectAutopilotRun,
  emptyAutopilot,
  loadAutopilot,
  resetAutopilot,
  setAutopilotFilters,
  type AutopilotHost,
} from "./autopilot";
import { DEFAULT_PROJECTS_STATE } from "./projects";

export const routines: AutopilotRoutinesListResult = {
  routines: [],
  source: { kind: "project", path: null },
  digest: "digest",
  error: null,
  catalogue: [],
  editions: { core: ["general"] },
  flags: [],
  control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
};
export const runs: AutopilotRunsListResult = { runs: [], total: 0, nextCursor: null };
export const stats: AutopilotStatsResult = {
  from: null,
  to: null,
  routines: [],
  areas: [],
  totals: {
    runs: 9,
    failedRuns: 1,
    items: 30,
    prepared: 10,
    acted: 2,
    escalated: 3,
    handled: 12,
    correctedByPerson: 1,
    minutesSaved: null,
  },
  control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
};
const autonomy: AutopilotAutonomyProposalsResult = {
  policy: {
    windowDays: 30,
    minItemsToPromote: 20,
    promoteAtOrBelow: 0.05,
    minItemsToDemote: 10,
    demoteAtOrAbove: 0.2,
  },
  proposals: [],
};
function setup() {
  const request = vi.fn(async (method: string) =>
    method === "autopilot.routines.list"
      ? routines
      : method === "autopilot.runs.list"
        ? runs
        : method === "autopilot.autonomy.proposals"
          ? autonomy
          : stats,
  );
  const host: AutopilotHost = {
    autopilot: emptyAutopilot(),
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    tab: "projects",
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "autopilot" },
  };
  return { host, request };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("Autopilot read-only controller", () => {
  it("loads server proposals and isolates unavailable proposal RPCs from run history", async () => {
    const { host, request } = setup();
    await loadAutopilot(host);
    expect(host.autopilot.autonomy).toEqual(autonomy);
    request.mockImplementation(async (method: string) => {
      if (method === "autopilot.autonomy.proposals") {
        throw new Error("unsupported");
      }
      return method === "autopilot.routines.list"
        ? routines
        : method === "autopilot.runs.list"
          ? runs
          : stats;
    });
    await loadAutopilot(host);
    expect(host.autopilot.autonomy).toBeNull();
    expect(host.autopilot.autonomyError).toBe(true);
    expect(host.autopilot.error).toBe(false);
    expect(host.autopilot.runs).toEqual(runs);
  });
  it("does not leak delayed proposals across projects", async () => {
    const { host, request } = setup();
    const pending = deferred<typeof autonomy>();
    request.mockImplementation(async (method: string) =>
      method === "autopilot.autonomy.proposals"
        ? pending.promise
        : method === "autopilot.routines.list"
          ? routines
          : method === "autopilot.runs.list"
            ? runs
            : stats,
    );
    const loading = loadAutopilot(host);
    host.projects.selectedId = "p2";
    resetAutopilot(host);
    pending.resolve(autonomy);
    await loading;
    expect(host.autopilot.autonomy).toBeNull();
  });
  it("loads exact read RPCs and preserves server totals including unknown minutes", async () => {
    const { host, request } = setup();
    await loadAutopilot(host);
    expect(request.mock.calls).toEqual([
      ["autopilot.routines.list", { projectId: "p1" }],
      ["autopilot.runs.list", { projectId: "p1", limit: 20 }],
      ["autopilot.stats", { projectId: "p1" }],
      ["autopilot.autonomy.proposals", { projectId: "p1" }],
      ["autopilot.brief.get", { projectId: "p1" }],
    ]);
    expect(host.autopilot.stats).toEqual(stats);
    expect(host.autopilot.stats?.totals.minutesSaved).toBeNull();
  });
  it("preserves server filters for history, refresh and events while totals stay project-wide", async () => {
    const { host, request } = setup();
    await loadAutopilot(host, "old-scope");
    await setAutopilotFilters(host, { edition: "business", area: "finance" });
    expect(host.autopilot.cursor).toBeNull();
    const expected = { projectId: "p1", limit: 20, edition: "business", area: "finance" };
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", expected);
    await loadAutopilot(host, "filtered-history");
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", {
      ...expected,
      cursor: "filtered-history",
    });
    await loadAutopilot(host);
    autopilotEvent(host, { projectId: "p1" });
    await vi.waitFor(() => expect(host.autopilot.loading).toBe(false));
    expect(host.autopilot.filters).toEqual({ edition: "business", area: "finance" });
    expect(request.mock.calls.filter(([method]) => method === "autopilot.stats")).toEqual(
      Array(5).fill(["autopilot.stats", { projectId: "p1" }]),
    );
    expect(host.autopilot.stats).toEqual(stats);
    host.projects.selectedId = "p2";
    await loadAutopilot(host);
    expect(host.autopilot.filters).toEqual({});
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", { projectId: "p2", limit: 20 });
  });
  it("rejects stale filter responses and coalesces events using the newest filters", async () => {
    const { host, request } = setup();
    const old = deferred<typeof routines>();
    request.mockImplementationOnce(async () => old.promise);
    const first = setAutopilotFilters(host, { edition: "business", area: "finance" });
    await setAutopilotFilters(host, { edition: "core", area: "general" });
    old.resolve({ ...routines, digest: "stale-filter" });
    await first;
    expect(host.autopilot.filters).toEqual({ edition: "core", area: "general" });
    expect(host.autopilot.routines?.digest).toBe("digest");
    const latest = deferred<typeof routines>();
    request.mockImplementationOnce(async () => latest.promise);
    const pending = loadAutopilot(host);
    autopilotEvent(host, { projectId: "p1" });
    latest.resolve(routines);
    await pending;
    await vi.waitFor(() => expect(host.autopilot.loading).toBe(false));
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", {
      projectId: "p1",
      limit: 20,
      edition: "core",
      area: "general",
    });
    request.mockRejectedValueOnce(new Error("unavailable"));
    await loadAutopilot(host);
    expect(host.autopilot.filters).toEqual({ edition: "core", area: "general" });
    await setAutopilotFilters(host, {});
    expect(host.autopilot.filters).toEqual({});
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", { projectId: "p1", limit: 20 });
  });
  it("loads an opaque history cursor and refresh returns to latest", async () => {
    const { host, request } = setup();
    await loadAutopilot(host, "opaque-history");
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", {
      projectId: "p1",
      limit: 20,
      cursor: "opaque-history",
    });
    expect(host.autopilot.cursor).toBe("opaque-history");
    expect(host.autopilot.stats).toEqual(stats);
    await loadAutopilot(host);
    expect(host.autopilot.cursor).toBeNull();
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", { projectId: "p1", limit: 20 });
  });
  it("ignores a history response replaced by a refresh", async () => {
    const { host, request } = setup();
    const wait = deferred<typeof routines>();
    request.mockImplementationOnce(async () => wait.promise);
    const history = loadAutopilot(host, "older");
    await loadAutopilot(host);
    wait.resolve({ ...routines, digest: "stale-history" });
    await history;
    expect(host.autopilot.cursor).toBeNull();
    expect(host.autopilot.routines?.digest).toBe("digest");
  });
  it("discards history on reset and on a matching event", async () => {
    const { host, request } = setup();
    await loadAutopilot(host, "older");
    autopilotEvent(host, { projectId: "p1" });
    await vi.waitFor(() => expect(host.autopilot.loading).toBe(false));
    expect(host.autopilot.cursor).toBeNull();
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", { projectId: "p1", limit: 20 });
    await loadAutopilot(host, "older");
    resetAutopilot(host);
    expect(host.autopilot.cursor).toBeNull();
  });
  it.each(["project", "tab", "client", "disconnect", "reset"])(
    "rejects stale %s responses",
    async (change) => {
      const { host, request } = setup();
      const wait = deferred<typeof routines>();
      request.mockImplementation(async () => wait.promise);
      const loading = loadAutopilot(host);
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "tab") {
        host.projects.view = "chat";
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      if (change === "reset") {
        resetAutopilot(host);
      }
      wait.resolve(routines);
      await loading;
      expect(host.autopilot.routines).toBeNull();
    },
  );
  it("clears old project content before loading and ignores superseded responses", async () => {
    const { host, request } = setup();
    await loadAutopilot(host);
    const wait = deferred<typeof routines>();
    request.mockImplementationOnce(async () => wait.promise);
    const first = loadAutopilot(host);
    host.projects.selectedId = "p2";
    const second = loadAutopilot(host);
    expect(host.autopilot.routines).toBeNull();
    await second;
    wait.resolve({ ...routines, digest: "stale" });
    await first;
    expect(host.autopilot.projectId).toBe("p2");
    expect(host.autopilot.routines?.digest).toBe("digest");
  });
  it("does not load outside the selected project tab", async () => {
    const { host, request } = setup();
    host.projects.view = "chat";
    await loadAutopilot(host);
    host.projects.view = "autopilot";
    host.tab = "home";
    await loadAutopilot(host);
    host.tab = "projects";
    host.projects.selectedId = null;
    await loadAutopilot(host);
    expect(request).not.toHaveBeenCalled();
  });
  it("clears content on RPC failure", async () => {
    const { host, request } = setup();
    await loadAutopilot(host);
    request.mockRejectedValueOnce(new Error("forbidden"));
    await loadAutopilot(host);
    expect(host.autopilot.error).toBe(true);
    expect(host.autopilot.routines).toBeNull();
  });
  it("coalesces matching events during loading and ignores another project", async () => {
    const { host, request } = setup();
    const wait = deferred<typeof routines>();
    request.mockImplementationOnce(async () => wait.promise);
    const pending = loadAutopilot(host);
    autopilotEvent(host, { projectId: "p2" });
    expect(request).toHaveBeenCalledTimes(5);
    autopilotEvent(host, { projectId: "p1" });
    autopilotEvent(host, { projectId: "p1" });
    wait.resolve(routines);
    await pending;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(10));
    await vi.waitFor(() => expect(host.autopilot.loading).toBe(false));
  });
});

const detail: AutopilotRunsGetResult = {
  run: {
    id: "r1",
    projectId: "p1",
    routineId: "receipt",
    edition: "business",
    area: "finance",
    level: "L1",
    trigger: "manual",
    triggeredBy: "owner",
    startedAt: "2026-10-25T00:00:00Z",
    endedAt: "2026-10-25T00:01:00Z",
    status: "ok",
    reason: null,
    routineDigest: "d",
    reasoning: { backend: null, model: null, ms: 10, outputSha256: null },
    counts: {
      items: 1,
      prepared: 1,
      acted: 0,
      escalated: 0,
      refused: 0,
      failed: 0,
      handled: 1,
      deferred: 0,
    },
    workItems: [],
    evidence: null,
    gather: [],
    actions: [],
  },
  evidence: { ok: false, problems: ["Missing bundle"] },
};
async function detailSetup() {
  const { host } = setup();
  await loadAutopilot(host);
  host.autopilot.runs = {
    runs: [detail.run, { ...detail.run, id: "r2" }],
    total: 2,
    nextCursor: null,
  };
  const request = vi.fn(async () => detail);
  host.client = { request } as unknown as GatewayBrowserClient;
  return { host, request };
}
describe("Autopilot run inspection", () => {
  async function refreshSetup() {
    const { host } = await detailSetup();
    await inspectAutopilotRun(host, "r1");
    const page: AutopilotRunsListResult = { runs: [detail.run], total: 1, nextCursor: null };
    const read = vi.fn(async (method: string) => {
      if (method === "autopilot.routines.list") {
        return routines;
      }
      if (method === "autopilot.runs.list") {
        return page;
      }
      if (method === "autopilot.stats") {
        return stats;
      }
      return { ...detail, run: { ...detail.run, reason: "Refreshed" } };
    });
    host.client = { request: read } as unknown as GatewayBrowserClient;
    return { host, read, page };
  }
  it("keeps a visible selection on refresh and rechecks its evidence", async () => {
    const { host, read } = await refreshSetup();
    const pending = loadAutopilot(host);
    expect(host.autopilot.selectedRunId).toBe("r1");
    expect(host.autopilot.runDetail).toBeNull();
    await pending;
    expect(host.autopilot.selectedRunId).toBe("r1");
    expect(host.autopilot.runDetail?.run.reason).toBe("Refreshed");
    expect(read).toHaveBeenCalledWith("autopilot.runs.get", { projectId: "p1", id: "r1" });
  });
  it("refreshes selected evidence after a matching event", async () => {
    const { host } = await refreshSetup();
    autopilotEvent(host, { projectId: "p1" });
    await vi.waitFor(() => expect(host.autopilot.runDetail?.run.reason).toBe("Refreshed"));
    expect(host.autopilot.selectedRunId).toBe("r1");
  });
  it.each(["missing", "close", "filter", "project"])("drops selection after %s", async (change) => {
    const { host, read, page } = await refreshSetup();
    if (change === "missing") {
      page.runs = [];
    }
    if (change === "project") {
      host.projects.selectedId = "p2";
    }
    const pending =
      change === "filter" ? setAutopilotFilters(host, { area: "finance" }) : loadAutopilot(host);
    if (change === "close") {
      closeAutopilotRun(host);
    }
    await pending;
    expect(host.autopilot.selectedRunId).toBeNull();
    expect(host.autopilot.runDetail).toBeNull();
    expect(read.mock.calls.some(([method]) => method === "autopilot.runs.get")).toBe(false);
  });
  it("does not restore selection after close during overlapping refreshes", async () => {
    const { host, read, page } = await refreshSetup();
    const wait = deferred<AutopilotRunsListResult>();
    read.mockImplementationOnce(async () => routines);
    read.mockImplementationOnce(async () => wait.promise);
    const older = loadAutopilot(host);
    const newer = loadAutopilot(host);
    closeAutopilotRun(host);
    await newer;
    wait.resolve(page);
    await older;
    expect(host.autopilot.selectedRunId).toBeNull();
    expect(host.autopilot.runDetail).toBeNull();
  });

  it("reads a selected run and preserves failed evidence without inferring success from run status", async () => {
    const { host, request } = await detailSetup();
    await inspectAutopilotRun(host, "r1");
    expect(request).toHaveBeenCalledExactlyOnceWith("autopilot.runs.get", {
      projectId: "p1",
      id: "r1",
    });
    expect(host.autopilot.runDetail).toEqual(detail);
    expect(host.autopilot.runLoading).toBe(false);
    closeAutopilotRun(host);
    expect(host.autopilot.selectedRunId).toBeNull();
    expect(host.autopilot.runDetail).toBeNull();
  });
  it.each([true, false])("preserves a retention receipt with verification %s", async (ok) => {
    const { host, request } = await detailSetup();
    const receipt = {
      ...detail,
      evidence: { ok, problems: ok ? [] : ["Invalid signature"], tombstone: true },
    };
    request.mockResolvedValueOnce(receipt);
    await inspectAutopilotRun(host, "r1");
    expect(host.autopilot.runDetail).toEqual(receipt);
    expect(host.autopilot.selectedRunId).toBe("r1");
  });
  it("does not inspect an unknown run or while page data loads", async () => {
    const { host, request } = await detailSetup();
    await inspectAutopilotRun(host, "unknown");
    host.autopilot.loading = true;
    await inspectAutopilotRun(host, "r1");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "project",
    "view",
    "tab",
    "client",
    "disconnect",
    "reset",
    "close",
    "refresh",
    "run",
    "same-run",
  ])("rejects run responses after %s changes", async (change) => {
    const { host, request } = await detailSetup();
    const wait = deferred<AutopilotRunsGetResult>();
    request.mockImplementationOnce(async () => wait.promise);
    const pending = inspectAutopilotRun(host, "r1");
    if (change === "project") {
      host.projects.selectedId = "p2";
    }
    if (change === "view") {
      host.projects.view = "chat";
    }
    if (change === "tab") {
      host.tab = "home";
    }
    if (change === "client") {
      host.client = {} as GatewayBrowserClient;
    }
    if (change === "disconnect") {
      host.connected = false;
    }
    if (change === "reset") {
      resetAutopilot(host);
    }
    if (change === "close") {
      closeAutopilotRun(host);
    }
    if (change === "refresh") {
      await loadAutopilot(host);
    }
    if (change === "run" || change === "same-run") {
      request.mockResolvedValueOnce({
        ...detail,
        run: { ...detail.run, id: change === "run" ? "r2" : "r1", reason: "Newest" },
      });
      await inspectAutopilotRun(host, change === "run" ? "r2" : "r1");
    }
    const before = host.autopilot;
    wait.resolve({
      ...detail,
      evidence: { ok: true, problems: [], tombstone: true },
    } as typeof detail);
    await pending;
    expect(host.autopilot).toBe(before);
  });
  it("clears previous details on errors and allows retry", async () => {
    const { host, request } = await detailSetup();
    await inspectAutopilotRun(host, "r1");
    request.mockRejectedValueOnce(new Error("forbidden"));
    await inspectAutopilotRun(host, "r1");
    expect(host.autopilot.runError).toBe(true);
    expect(host.autopilot.runDetail).toBeNull();
    await inspectAutopilotRun(host, "r1");
    expect(host.autopilot.runError).toBe(false);
    expect(host.autopilot.runDetail).toEqual(detail);
  });
  it.each(["projectId", "id"] as const)("rejects mismatched response %s", async (key) => {
    const { host, request } = await detailSetup();
    request.mockResolvedValueOnce({ ...detail, run: { ...detail.run, [key]: "wrong" } });
    await inspectAutopilotRun(host, "r1");
    expect(host.autopilot.runError).toBe(true);
    expect(host.autopilot.runDetail).toBeNull();
  });
});

describe("Autonomy decline", () => {
  async function ready() {
    const { host } = setup();
    await loadAutopilot(host);
    host.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.approvals"] },
    };
    host.autopilot.autonomy = {
      ...autonomy,
      proposals: [
        {
          routineId: "receipt",
          kind: "promote",
          current: "L1",
          proposed: "L2",
          reason: "low_correction_rate",
          needsStandingApproval: false,
          fileLevel: "L2",
          acceptBlocker: null,
          declined: null,
          evidence: {
            from: "2026-10-01",
            to: "2026-10-25",
            runs: 3,
            failedRuns: 0,
            workItems: 25,
            corrected: 0,
            correctionRate: 0,
            escalated: 0,
          },
        },
      ],
    };
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "autopilot.routines.list"
          ? routines
          : method === "autopilot.runs.list"
            ? runs
            : method === "autopilot.stats"
              ? stats
              : method === "autopilot.autonomy.proposals"
                ? autonomy
                : {},
    );
    host.client = { request } as unknown as GatewayBrowserClient;
    setAutonomyDeclineReason(host, "receipt", "  Needs review  ");
    return { host, request };
  }
  it("uses granted operator approval scopes and fails closed for missing auth, other roles and read-only scopes", async () => {
    const { host, request } = await ready();
    for (const auth of [
      undefined,
      { role: "operator", scopes: ["operator.read"] },
      { role: "node", scopes: ["operator.admin"] },
    ]) {
      host.hello!.auth = auth;
      expect(canDeclineAutonomy(host)).toBe(false);
      await declineAutonomy(host, "receipt");
    }
    expect(request).not.toHaveBeenCalled();
    host.hello!.auth = { role: "operator", scopes: ["operator.admin"] };
    expect(canDeclineAutonomy(host)).toBe(true);
  });
  it.each(["", "   ", " abc ", "x".repeat(1001)])(
    "rejects invalid reasons locally (%s)",
    async (reason) => {
      const { host, request } = await ready();
      setAutonomyDeclineReason(host, "receipt", reason);
      await declineAutonomy(host, "receipt");
      expect(request).not.toHaveBeenCalled();
      expect(host.autopilot.declineStatus).toBe("declineInvalid");
    },
  );
  it.each(["hold", "declined", "missing"])("does not submit %s proposals", async (kind) => {
    const { host, request } = await ready();
    const proposal = host.autopilot.autonomy!.proposals[0];
    if (kind === "hold") {
      proposal.kind = "hold";
    }
    if (kind === "declined") {
      proposal.declined = { by: "owner", at: "2026-10-25", reason: "Wait" };
    }
    if (kind === "missing") {
      host.autopilot.autonomy!.proposals = [];
    }
    await declineAutonomy(host, "receipt");
    expect(request).not.toHaveBeenCalled();
  });
  it("submits the displayed tuple, trims reason, blocks duplicate submits and queues pre-response events", async () => {
    const { host, request } = await ready();
    const wait = deferred<unknown>();
    request.mockImplementationOnce(() => wait.promise);
    const pending = declineAutonomy(host, "receipt");
    await declineAutonomy(host, "receipt");
    autopilotEvent(host, { projectId: "p1" });
    autopilotEvent(host, { projectId: "p1" });
    await loadAutopilot(host);
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.autopilot.declinePending).toBe("receipt");
    expect(request).toHaveBeenCalledWith("autopilot.autonomy.decline", {
      projectId: "p1",
      routineId: "receipt",
      kind: "promote",
      proposed: "L2",
      reason: "Needs review",
    });
    wait.resolve({});
    await pending;
    expect(request).toHaveBeenCalledTimes(6);
    expect(host.autopilot.declinePending).toBeNull();
    expect(host.autopilot.declineStatus).toBe("declineSaved");
    expect(host.autopilot.declineReasons.receipt).toBe("");
  });
  it.each(["project", "client", "reset", "disconnect"])(
    "ignores stale %s mutation responses",
    async (change) => {
      const { host, request } = await ready();
      const wait = deferred<unknown>();
      request.mockImplementationOnce(() => wait.promise);
      const pending = declineAutonomy(host, "receipt");
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "reset") {
        resetAutopilot(host);
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      wait.resolve({});
      await pending;
      expect(host.autopilot.declineStatus).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves the written reason when a queued reload fails after a declined request", async () => {
    const { host, request } = await ready();
    const wait = deferred<unknown>();
    request.mockImplementationOnce(() => wait.promise);
    const pending = declineAutonomy(host, "receipt");
    autopilotEvent(host, { projectId: "p1" });
    request.mockRejectedValueOnce(new Error("read unavailable"));
    // A stale proposal refusal requires a reload, even when that read is unavailable.
    wait.resolve(Promise.reject({ details: { code: "proposal_changed" } }));
    await pending;
    expect(host.autopilot.error).toBe(true);
    expect(host.autopilot.declineReasons.receipt).toBe("  Needs review  ");
    expect(host.autopilot.declineStatus).toBe("declineChanged");
  });
  it("waits for the old project write before allowing a new project mutation", async () => {
    const { host, request } = await ready();
    const proposals = host.autopilot.autonomy;
    const old = deferred<unknown>();
    request.mockImplementationOnce(() => old.promise);
    const pending = declineAutonomy(host, "receipt");
    host.projects.selectedId = "p2";
    await loadAutopilot(host);
    await declineAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledTimes(1);
    old.resolve({});
    await pending;
    expect(host.autopilot.projectId).toBe("p2");
    expect(host.autopilot.declineStatus).toBeNull();
    host.autopilot.autonomy = proposals;
    setAutonomyDeclineReason(host, "receipt", "x".repeat(1000));
    await declineAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledWith("autopilot.autonomy.decline", {
      projectId: "p2",
      routineId: "receipt",
      kind: "promote",
      proposed: "L2",
      reason: "x".repeat(1000),
    });
  });
  it.each(["proposal_changed", "nothing_to_decline", "not_a_person", "forbidden"])(
    "localizes %s and refreshes stale proposals",
    async (code) => {
      const { host, request } = await ready();
      request.mockRejectedValueOnce({ details: { code } });
      await declineAutonomy(host, "receipt");
      const stale = code === "proposal_changed" || code === "nothing_to_decline";
      expect(request).toHaveBeenCalledTimes(stale ? 6 : 1);
      expect(host.autopilot.declineStatus).toBe(stale ? "declineChanged" : "declineFailed");
      expect(host.autopilot.declinePending).toBeNull();
    },
  );
});

describe("Autonomy accept", () => {
  async function ready() {
    const { host } = setup();
    await loadAutopilot(host);
    host.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.approvals"] },
    };
    host.autopilot.autonomy = {
      ...autonomy,
      proposals: [
        {
          routineId: "receipt",
          kind: "promote",
          current: "L1",
          proposed: "L2",
          reason: "low_correction_rate",
          needsStandingApproval: false,
          fileLevel: "L2",
          acceptBlocker: null,
          declined: null,
          evidence: {
            from: "2026-10-01",
            to: "2026-10-25",
            runs: 3,
            failedRuns: 0,
            workItems: 25,
            corrected: 0,
            correctionRate: 0,
            escalated: 0,
          },
        },
      ],
    };
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "autopilot.routines.list"
          ? routines
          : method === "autopilot.runs.list"
            ? runs
            : method === "autopilot.stats"
              ? stats
              : method === "autopilot.autonomy.proposals"
                ? autonomy
                : {},
    );
    host.client = { request } as unknown as GatewayBrowserClient;
    setAutonomyDeclineReason(host, "receipt", "  Needs review  ");
    return { host, request };
  }
  it("uses granted operator approval scopes and fails closed for missing auth, other roles and read-only scopes", async () => {
    const { host, request } = await ready();
    for (const auth of [
      undefined,
      { role: "operator", scopes: ["operator.read"] },
      { role: "node", scopes: ["operator.admin"] },
    ]) {
      host.hello!.auth = auth;
      expect(canAcceptAutonomy(host)).toBe(false);
      await acceptAutonomy(host, "receipt");
    }
    expect(request).not.toHaveBeenCalled();
    host.hello!.auth = { role: "operator", scopes: ["operator.admin"] };
    expect(canAcceptAutonomy(host)).toBe(true);
  });
  it.each(["", "   ", " abc ", "x".repeat(1001)])(
    "rejects invalid reasons locally (%s)",
    async (reason) => {
      const { host, request } = await ready();
      setAutonomyDeclineReason(host, "receipt", reason);
      await acceptAutonomy(host, "receipt");
      expect(request).not.toHaveBeenCalled();
      expect(host.autopilot.acceptStatus).toBe("acceptInvalid");
    },
  );
  it.each([
    "hold",
    "declined",
    "missing",
    "above_file_level",
    "no_standing_approval",
    "missing-blocker",
  ])("does not submit %s proposals", async (kind) => {
    const { host, request } = await ready();
    const proposal = host.autopilot.autonomy!.proposals[0];
    if (kind === "hold") {
      proposal.kind = "hold";
    }
    if (kind === "declined") {
      proposal.declined = { by: "owner", at: "2026-10-25", reason: "Wait" };
    }
    if (kind === "missing") {
      host.autopilot.autonomy!.proposals = [];
    }
    if (kind === "above_file_level" || kind === "no_standing_approval") {
      proposal.acceptBlocker = kind;
    }
    if (kind === "missing-blocker") {
      Reflect.deleteProperty(proposal, "acceptBlocker");
    }
    await acceptAutonomy(host, "receipt");
    expect(request).not.toHaveBeenCalled();
  });
  it("submits the displayed tuple, trims reason, blocks duplicate submits and queues pre-response events", async () => {
    const { host, request } = await ready();
    const wait = deferred<unknown>();
    request.mockImplementationOnce(() => wait.promise);
    const pending = acceptAutonomy(host, "receipt");
    await acceptAutonomy(host, "receipt");
    await declineAutonomy(host, "receipt");
    host.autopilot.routines = {
      ...routines,
      routines: [
        {
          id: "receipt",
          state: { paused: false, pausedBy: null },
        } as AutopilotRoutinesListResult["routines"][number],
      ],
    };
    await changeAutopilotRoutine(host, "receipt", "pause");
    setAutonomyDeclineReason(host, "receipt", "Changed while pending");
    expect(host.autopilot.declineReasons.receipt).toBe("  Needs review  ");
    autopilotEvent(host, { projectId: "p1" });
    autopilotEvent(host, { projectId: "p1" });
    await loadAutopilot(host);
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.autopilot.acceptPending).toBe("receipt");
    expect(request).toHaveBeenCalledWith("autopilot.autonomy.accept", {
      projectId: "p1",
      routineId: "receipt",
      kind: "promote",
      proposed: "L2",
      reason: "Needs review",
    });
    wait.resolve({});
    await pending;
    expect(request).toHaveBeenCalledTimes(6);
    expect(host.autopilot.acceptPending).toBeNull();
    expect(host.autopilot.acceptStatus).toBe("acceptSaved");
    expect(host.autopilot.declineReasons.receipt).toBe("");
  });
  it.each(["project", "client", "reset", "disconnect", "tab", "view"])(
    "ignores stale %s mutation responses",
    async (change) => {
      const { host, request } = await ready();
      const wait = deferred<unknown>();
      request.mockImplementationOnce(() => wait.promise);
      const pending = acceptAutonomy(host, "receipt");
      if (change === "tab") {
        host.tab = "home";
      }
      if (change === "view") {
        host.projects.view = "chat";
      }
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "reset") {
        resetAutopilot(host);
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      wait.resolve({});
      await pending;
      expect(host.autopilot.acceptStatus).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves the written reason when a queued reload fails after a declined request", async () => {
    const { host, request } = await ready();
    const wait = deferred<unknown>();
    request.mockImplementationOnce(() => wait.promise);
    const pending = acceptAutonomy(host, "receipt");
    autopilotEvent(host, { projectId: "p1" });
    request.mockRejectedValueOnce(new Error("read unavailable"));
    // A stale proposal refusal requires a reload, even when that read is unavailable.
    wait.resolve(Promise.reject({ details: { code: "proposal_changed" } }));
    await pending;
    expect(host.autopilot.error).toBe(true);
    expect(host.autopilot.declineReasons.receipt).toBe("  Needs review  ");
    expect(host.autopilot.acceptStatus).toBe("acceptChanged");
  });
  it("waits for the old project write before allowing a new project mutation", async () => {
    const { host, request } = await ready();
    const proposals = host.autopilot.autonomy;
    const old = deferred<unknown>();
    request.mockImplementationOnce(() => old.promise);
    const pending = acceptAutonomy(host, "receipt");
    host.projects.selectedId = "p2";
    await loadAutopilot(host);
    await acceptAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledTimes(1);
    old.resolve({});
    await pending;
    expect(host.autopilot.projectId).toBe("p2");
    expect(host.autopilot.acceptStatus).toBeNull();
    host.autopilot.autonomy = proposals;
    setAutonomyDeclineReason(host, "receipt", "x".repeat(1000));
    await acceptAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledWith("autopilot.autonomy.accept", {
      projectId: "p2",
      routineId: "receipt",
      kind: "promote",
      proposed: "L2",
      reason: "x".repeat(1000),
    });
  });
  it.each([
    "proposal_changed",
    "nothing_to_accept",
    "above_file_level",
    "no_standing_approval",
    "not_a_person",
    "forbidden",
    "offline",
  ])("localizes %s and refreshes stale proposals", async (code) => {
    const { host, request } = await ready();
    request.mockRejectedValueOnce({ details: { code } });
    await acceptAutonomy(host, "receipt");
    const stale = [
      "proposal_changed",
      "nothing_to_accept",
      "above_file_level",
      "no_standing_approval",
    ].includes(code);
    expect(request).toHaveBeenCalledTimes(stale ? 6 : 1);
    expect(host.autopilot.acceptStatus).toBe(stale ? "acceptChanged" : "acceptFailed");
    expect(host.autopilot.acceptPending).toBeNull();
    expect(host.autopilot.declineReasons.receipt).toBe("  Needs review  ");
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.autonomy.accept"),
    ).toHaveLength(1);
  });
  it.each(["decline", "pause", "resume"] as const)(
    "blocks Accept while %s owns the shared lock",
    async (action) => {
      const { host, request } = await ready();
      host.autopilot.routines = {
        ...routines,
        routines: [
          {
            id: "receipt",
            state: { paused: action === "resume", pausedBy: "person" },
          } as AutopilotRoutinesListResult["routines"][number],
        ],
      };
      setAutopilotRoutineReason(host, "receipt", "Reviewed");
      const wait = deferred<unknown>();
      request.mockImplementationOnce(() => wait.promise);
      const pending =
        action === "decline"
          ? declineAutonomy(host, "receipt")
          : changeAutopilotRoutine(host, "receipt", action);
      await acceptAutonomy(host, "receipt");
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).not.toBe("autopilot.autonomy.accept");
      wait.resolve({});
      await pending;
    },
  );
  it("preserves the selected history page when acceptance refreshes evidence", async () => {
    const { host, request } = await ready();
    host.autopilot.cursor = "history-page-2";
    await acceptAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", {
      projectId: "p1",
      limit: 20,
      cursor: "history-page-2",
    });
    expect(host.autopilot.cursor).toBe("history-page-2");
    expect(host.autopilot.acceptStatus).toBe("acceptSaved");
  });
  it("accepts demotions and clears stale status when the shared reason changes", async () => {
    const { host, request } = await ready();
    const proposal = host.autopilot.autonomy!.proposals[0];
    proposal.kind = "demote";
    proposal.proposed = "L0";
    host.autopilot.acceptStatus = "acceptFailed";
    host.autopilot.declineStatus = "declineFailed";
    setAutonomyDeclineReason(host, "receipt", "abcd");
    expect(host.autopilot.acceptStatus).toBeNull();
    expect(host.autopilot.declineStatus).toBeNull();
    await acceptAutonomy(host, "receipt");
    expect(request).toHaveBeenCalledWith("autopilot.autonomy.accept", {
      projectId: "p1",
      routineId: "receipt",
      kind: "demote",
      proposed: "L0",
      reason: "abcd",
    });
    expect(host.autopilot.acceptStatus).toBe("acceptSaved");
  });
});

describe("routine pause and resume", () => {
  async function ready(paused = false, pausedBy: string | null = null) {
    const { host, request } = setup();
    await loadAutopilot(host);
    host.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.approvals"] },
    };
    host.autopilot.routines = {
      ...routines,
      routines: [
        {
          id: "receipt",
          state: { paused, pausedBy },
        } as AutopilotRoutinesListResult["routines"][number],
      ],
    };
    setAutopilotRoutineReason(host, "receipt", "  Reviewed  ");
    request.mockClear();
    return { host, request };
  }
  afterEach(() => vi.useRealTimers());
  it.each([false, true])(
    "blocks a pause while the current read is pending (read rejects=%s)",
    async (reject) => {
      const { host, request } = await ready();
      const listed = host.autopilot.routines!;
      const pending = deferred<typeof routines>();
      request.mockImplementationOnce(async () => {
        await pending.promise;
        if (reject) {
          throw new Error("Read failed");
        }
        return listed;
      });
      const reading = loadAutopilot(host);
      expect(host.autopilot.loading).toBe(true);
      await changeAutopilotRoutine(host, "receipt", "pause");
      expect(request.mock.calls.some(([method]) => method === "autopilot.pause")).toBe(false);
      pending.resolve(listed);
      await reading;
      expect(host.autopilot.loading).toBe(false);
      expect(host.autopilot.error).toBe(reject);
      expect(host.autopilot.mutationDelayed).toBe(false);
    },
  );
  it.each([false, true])(
    "preserves a delayed pause when a superseded read settles (read rejects=%s)",
    async (reject) => {
      vi.useFakeTimers();
      const { host, request } = await ready();
      const listed = host.autopilot.routines!;
      const oldRead = deferred<typeof routines>();
      request.mockImplementationOnce(async () => {
        await oldRead.promise;
        if (reject) {
          throw new Error("Old read failed");
        }
        return routines;
      });
      const reading = loadAutopilot(host);
      request.mockResolvedValueOnce(listed);
      await loadAutopilot(host);
      const pendingWrite = deferred<typeof routines>();
      request.mockImplementationOnce(() => pendingWrite.promise);
      const writing = changeAutopilotRoutine(host, "receipt", "pause");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.autopilot.mutationDelayed).toBe(true);
      const before = host.autopilot;
      oldRead.resolve(routines);
      await reading;
      expect(host.autopilot).toBe(before);
      expect(host.autopilot.mutationDelayed).toBe(true);
      await changeAutopilotRoutine(host, "receipt", "pause");
      expect(request.mock.calls.filter(([method]) => method === "autopilot.pause")).toHaveLength(1);
      pendingWrite.resolve(routines);
      await writing;
      expect(host.autopilot.mutationDelayed).toBe(false);
      expect(host.autopilot.routineStatus).toBe("routinePaused");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([null, "watchdog", "stopAll"])(
    "resumes a %s pause and displays refreshed server state",
    async (pausedBy) => {
      const { host, request } = await ready(true, pausedBy);
      setAutopilotRoutineReason(host, "receipt", pausedBy ? "  Reviewed  " : "");
      // Mutation data is never trusted as a replacement for the scoped list read.
      request.mockResolvedValueOnce({
        routine: { id: "untrusted-response" },
      } as unknown as typeof routines);
      await changeAutopilotRoutine(host, "receipt", "resume");
      expect(request).toHaveBeenCalledWith("autopilot.resume", {
        projectId: "p1",
        routineId: "receipt",
        ...(pausedBy ? { reason: "Reviewed" } : {}),
      });
      expect(host.autopilot.routineStatus).toBe("routineResumed");
      expect(host.autopilot.routines).toEqual(routines);
      expect(host.autopilot.routineReasons.receipt).toBe("");
    },
  );
  it("blocks routine writes while a decline owns the mutation lock", async () => {
    const { host, request } = await ready();
    host.autopilot.autonomy = {
      ...autonomy,
      proposals: [
        {
          routineId: "receipt",
          kind: "promote",
          current: "L1",
          proposed: "L2",
          declined: null,
        } as AutopilotAutonomyProposalsResult["proposals"][number],
      ],
    };
    setAutonomyDeclineReason(host, "receipt", "Needs review");
    const pending = deferred<typeof routines>();
    request.mockImplementationOnce(() => pending.promise);
    const declining = declineAutonomy(host, "receipt");
    await changeAutopilotRoutine(host, "receipt", "pause");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("autopilot.autonomy.decline");
    pending.resolve(routines);
    await declining;
  });
  it("gates scopes, existing state, global stop and reason length without writes", async () => {
    const { host, request } = await ready();
    host.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    await changeAutopilotRoutine(host, "receipt", "pause");
    host.hello!.auth = { role: "operator", scopes: ["operator.approvals"] };
    await changeAutopilotRoutine(host, "receipt", "resume");
    for (const reason of ["   ", "x".repeat(1001)]) {
      setAutopilotRoutineReason(host, "receipt", reason);
      await changeAutopilotRoutine(host, "receipt", "pause");
    }
    expect(request).not.toHaveBeenCalled();
    const resumed = await ready(true, "watchdog");
    setAutopilotRoutineReason(resumed.host, "receipt", " abc ");
    await changeAutopilotRoutine(resumed.host, "receipt", "resume");
    expect(resumed.host.autopilot.routineStatus).toBe("routineInvalid");
    resumed.host.autopilot.routines!.control = { ...routines.control, stopped: true };
    await changeAutopilotRoutine(resumed.host, "receipt", "resume");
    expect(resumed.host.autopilot.routineStatus).toBe("routineStopped");
    expect(resumed.request).not.toHaveBeenCalled();
  });
  it("coalesces events and blocks duplicate writes and declines until pause settles", async () => {
    const { host, request } = await ready();
    const pending = deferred<typeof routines>();
    request.mockImplementationOnce(() => pending.promise);
    const saving = changeAutopilotRoutine(host, "receipt", "pause");
    autopilotEvent(host, { projectId: "p1" });
    await changeAutopilotRoutine(host, "receipt", "pause");
    await declineAutonomy(host, "receipt");
    setAutopilotRoutineReason(host, "receipt", "changed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("autopilot.pause", {
      projectId: "p1",
      routineId: "receipt",
      reason: "Reviewed",
    });
    pending.resolve(routines);
    await saving;
    expect(host.autopilot.routineStatus).toBe("routinePaused");
    expect(host.autopilot.routineReasons.receipt).toBe("");
    expect(request).toHaveBeenCalledTimes(6);
  });
  it.each(["stopped_all", "emergency_stop"])(
    "refreshes a stale resume after %s and prevents another write",
    async (code) => {
      const { host, request } = await ready(true, "person");
      const stopped = {
        ...host.autopilot.routines!,
        control: {
          ...routines.control,
          stopped: code === "stopped_all",
          emergencyStop: code === "emergency_stop",
        },
      };
      request.mockRejectedValueOnce({ details: { code } });
      request.mockResolvedValueOnce(stopped);
      await changeAutopilotRoutine(host, "receipt", "resume");
      expect(host.autopilot.routineStatus).toBe("routineStopped");
      expect(host.autopilot.routines).toEqual(stopped);
      expect(host.autopilot.routineReasons.receipt).toBe("  Reviewed  ");
      expect(host.autopilot.routinePending).toBeNull();
      expect(request).toHaveBeenCalledTimes(6);
      await changeAutopilotRoutine(host, "receipt", "resume");
      expect(request).toHaveBeenCalledTimes(6);
      expect(request.mock.calls.filter(([method]) => method === "autopilot.resume")).toHaveLength(
        1,
      );
    },
  );
  it.each([
    "already_paused",
    "not_paused",
    "reason_required",
    "stopped_all",
    "emergency_stop",
    "offline",
  ])("preserves reason after %s without retrying the write", async (code) => {
    const { host, request } = await ready();
    request.mockRejectedValueOnce({ details: { code } });
    await changeAutopilotRoutine(host, "receipt", "pause");
    expect(host.autopilot.routineReasons.receipt).toBe("  Reviewed  ");
    expect(request.mock.calls.filter(([method]) => method === "autopilot.pause")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(code === "offline" ? 1 : 6);
    expect(host.autopilot.routinePending).toBeNull();
  });
  it.each(["project", "tab", "client", "reset", "disconnect"])(
    "ignores delayed mutation after %s",
    async (change) => {
      const { host, request } = await ready();
      const pending = deferred<typeof routines>();
      request.mockImplementationOnce(() => pending.promise);
      const saving = changeAutopilotRoutine(host, "receipt", "pause");
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "tab") {
        host.tab = "chat";
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "reset") {
        resetAutopilot(host);
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      pending.resolve(routines);
      await saving;
      expect(host.autopilot.routineStatus).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

describe("caller-scoped morning brief reads", () => {
  it("keeps the server snapshot and never sends caller identity or history filters", async () => {
    const { host, request } = setup();
    const original = request.getMockImplementation()!;
    const brief = { projectId: "p1", principal: "person:alice", handled: { items: 27 } };
    request.mockImplementation(async (method: string) => {
      if (method === "autopilot.brief.get") {
        return { brief } as unknown as Awaited<ReturnType<typeof original>>;
      }
      return original(method);
    });
    await loadAutopilot(host);
    await setAutopilotFilters(host, { edition: "business", area: "finance" });
    expect(host.autopilot.brief).toEqual(brief);
    expect(host.autopilot.briefError).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "autopilot.brief.get")).toEqual([
      ["autopilot.brief.get", { projectId: "p1" }],
      ["autopilot.brief.get", { projectId: "p1" }],
    ]);
  });

  it("requests only the selected project and keeps an unsupported brief independent of history", async () => {
    const { host, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "autopilot.brief.get") {
        throw new Error("unsupported");
      }
      return original(method);
    });
    await loadAutopilot(host);
    expect(request).toHaveBeenCalledWith("autopilot.brief.get", { projectId: "p1" });
    expect(host.autopilot.briefError).toBe(true);
    expect(host.autopilot.error).toBe(false);
    expect(host.autopilot.runs).toEqual(runs);
  });
  it.each(["project", "client", "reset"])(
    "rejects a delayed brief after %s changes",
    async (change) => {
      const { host, request } = setup();
      const pending = deferred<unknown>();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method: string) => {
        if (method === "autopilot.brief.get") {
          return pending.promise as ReturnType<typeof original>;
        }
        return original(method);
      });
      const loading = loadAutopilot(host);
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "client") {
        host.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      }
      if (change === "reset") {
        resetAutopilot(host);
      }
      pending.resolve({ brief: { projectId: "p1", principal: "private-principal" } });
      await loading;
      expect(host.autopilot.brief).toBeNull();
    },
  );
  it("rejects a brief whose project does not match the active project", async () => {
    const { host, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "autopilot.brief.get") {
        return { brief: { projectId: "p2" } } as unknown as Awaited<ReturnType<typeof original>>;
      }
      return original(method);
    });
    await loadAutopilot(host);
    expect(host.autopilot.brief).toBeNull();
    expect(host.autopilot.briefError).toBe(true);
  });
});

describe("Autopilot error reports", () => {
  async function ready() {
    const { host, request: initialRequest } = setup();
    await loadAutopilot(host);
    host.hello = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.approvals"] },
    };
    host.autopilot.selectedRunId = "r1";
    host.autopilot.runDetail = { ...detail, run: { ...detail.run, workItems: ["item1"] } };
    host.autopilot.cursor = "history";
    setAutopilotReportReason(host, "item1", "  Wrong recipient  ");
    const base = initialRequest.getMockImplementation()!;
    host.autopilot.runs = {
      runs: [detail.run, { ...detail.run, id: "r2" }],
      total: 2,
      nextCursor: null,
    };
    const request = vi.fn(
      async (method: string): Promise<unknown> =>
        method === "autopilot.runs.list"
          ? { runs: [detail.run, { ...detail.run, id: "r2" }], total: 2, nextCursor: null }
          : method === "autopilot.runs.get"
            ? { ...detail, run: { ...detail.run, id: host.autopilot.selectedRunId ?? "r1" } }
            : base(method),
    );
    host.client = { request } as unknown as GatewayBrowserClient;
    return { host, request };
  }
  it("submits only the inspected item and reason, then refreshes the same history page", async () => {
    const { host, request } = await ready();
    await reportAutopilotError(host, "item1");
    expect(request).toHaveBeenCalledWith("autopilot.reportError", {
      projectId: "p1",
      itemId: "item1",
      reason: "Wrong recipient",
    });
    expect(request).toHaveBeenCalledWith("autopilot.runs.list", {
      projectId: "p1",
      limit: 20,
      cursor: "history",
    });
    expect(host.autopilot.reportStatus).toBe("reportSaved");
    expect(host.autopilot.reportReasons.item1).toBe("");
    expect(request.mock.calls.filter(([method]) => method === "autopilot.runs.get")).toHaveLength(
      1,
    );
  });
  it.each([
    "reader",
    "agent",
    "disconnected",
    "otherProject",
    "otherRun",
    "loading",
    "invalidReason",
    "unlistedItem",
  ])("refuses %s without a write", async (mode) => {
    const { host, request } = await ready();
    if (mode === "reader") {
      host.hello!.auth!.scopes = ["operator.read"];
    }
    if (mode === "agent") {
      host.hello!.auth!.role = "node";
    }
    if (mode === "disconnected") {
      host.connected = false;
    }
    if (mode === "otherProject") {
      host.autopilot.runDetail!.run.projectId = "p2";
    }
    if (mode === "otherRun") {
      host.autopilot.selectedRunId = "r2";
    }
    if (mode === "loading") {
      host.autopilot.runLoading = true;
    }
    if (mode === "invalidReason") {
      setAutopilotReportReason(host, "item1", "   ");
    }
    await reportAutopilotError(host, mode === "unlistedItem" ? "unknown" : "item1");
    expect(request).not.toHaveBeenCalled();
  });
  it("shares the mutation lock and coalesces events without losing the report reason", async () => {
    const { host, request } = await ready();
    const pending = deferred<typeof stats>();
    request.mockImplementationOnce(async () => pending.promise);
    const reporting = reportAutopilotError(host, "item1");
    await reportAutopilotError(host, "item1");
    await changeAutopilotRoutine(host, "receipt", "pause");
    await acceptAutonomy(host, "receipt");
    await declineAutonomy(host, "receipt");
    setAutopilotReportReason(host, "item1", "replacement");
    autopilotEvent(host, { projectId: "p1" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.autopilot.reportReasons.item1).toBe("  Wrong recipient  ");
    expect(host.autopilot.reportPending).toBe("item1");
    pending.resolve(stats);
    await reporting;
    expect(host.autopilot.reportPending).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "autopilot.runs.list")).toHaveLength(
      1,
    );
  });
  it.each(["switch", "close"])(
    "clears drafts and suppresses late result when run is %s",
    async (mode) => {
      const { host, request } = await ready();
      const pending = deferred<typeof stats>();
      request.mockImplementationOnce(async () => pending.promise);
      const reporting = reportAutopilotError(host, "item1");
      if (mode === "switch") {
        await inspectAutopilotRun(host, "r2");
      } else {
        closeAutopilotRun(host);
      }
      expect(host.autopilot.reportReasons).toEqual({});
      pending.resolve(stats);
      await reporting;
      expect(host.autopilot.reportPending).toBeNull();
      expect(host.autopilot.reportStatus).toBeNull();
      expect(host.autopilot.reportReasons).toEqual({});
      if (mode === "switch") {
        expect(host.autopilot.runDetail?.run.id).toBe("r2");
        expect(host.autopilot.runError).toBe(false);
      }
    },
  );
  it("does not restore a report result after closing and reopening during detail refresh", async () => {
    const { host, request } = await ready();
    const base = request.getMockImplementation()!;
    const delayed = deferred<typeof detail>();
    let firstDetail = true;
    request.mockImplementation(async (method: string) => {
      if (method === "autopilot.runs.get" && firstDetail) {
        firstDetail = false;
        return delayed.promise;
      }
      return base(method);
    });
    const reporting = reportAutopilotError(host, "item1");
    await vi.waitFor(() => expect(firstDetail).toBe(false));
    closeAutopilotRun(host);
    await inspectAutopilotRun(host, "r1");
    delayed.resolve(detail);
    await reporting;
    expect(host.autopilot.runDetail?.run.id).toBe("r1");
    expect(host.autopilot.reportStatus).toBeNull();
    expect(host.autopilot.reportPending).toBeNull();
    expect(host.autopilot.reportReasons).toEqual({});
  });
  it.each(["project", "connection", "reset"])(
    "ignores a late result after %s changes",
    async (mode) => {
      const { host, request } = await ready();
      const pending = deferred<typeof stats>();
      request.mockImplementationOnce(async () => pending.promise);
      const reporting = reportAutopilotError(host, "item1");
      if (mode === "project") {
        host.projects.selectedId = "p2";
      }
      if (mode === "connection") {
        host.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      }
      if (mode === "reset") {
        resetAutopilot(host);
      }
      const unchanged = host.autopilot;
      pending.resolve(stats);
      await reporting;
      expect(host.autopilot).toEqual(unchanged);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "already_reported",
    "item_not_found",
    "not_autopilot_item",
    "routine_not_found",
    "archived",
    "transport",
  ])("handles %s without exposing diagnostics or retrying the write", async (code) => {
    const { host, request } = await ready();
    request.mockRejectedValueOnce({ details: { code }, message: "private diagnostic" });
    await reportAutopilotError(host, "item1");
    expect(host.autopilot.reportStatus).toBe(
      code === "transport" ? "reportFailed" : "reportChanged",
    );
    expect(host.autopilot.reportReasons.item1).toBe("  Wrong recipient  ");
    expect(host.autopilot.reportPending).toBeNull();
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.reportError"),
    ).toHaveLength(1);
  });
});

describe("Business linked runs", () => {
  it.each([true, false])(
    "checks item membership outside the loaded run page: %s",
    async (matches) => {
      const { host, request } = await detailSetup();
      host.autopilot.runs = { runs: [], total: 0, nextCursor: null };
      host.autopilot.linkedRun = { id: "r1", itemId: "item1" };
      request.mockResolvedValue({
        ...detail,
        run: { ...detail.run, workItems: matches ? ["item1"] : [] },
      });
      await inspectAutopilotRun(host, "r1");
      expect(host.autopilot.runError).toBe(!matches);
      expect(host.autopilot.runDetail !== null).toBe(matches);
      closeAutopilotRun(host);
      expect(host.autopilot.linkedRun).toBeNull();
    },
  );
  it("keeps a linked run after refreshing a page that does not contain it", async () => {
    const { host } = setup();
    host.autopilot = {
      ...emptyAutopilot(),
      projectId: "p1",
      linkedRun: { id: "r1", itemId: "item1" },
      selectedRunId: "r1",
    };
    host.client = {
      request: vi.fn(async (method) =>
        method === "autopilot.runs.get"
          ? { ...detail, run: { ...detail.run, workItems: ["item1"] } }
          : method === "autopilot.runs.list"
            ? runs
            : method === "autopilot.routines.list"
              ? routines
              : stats,
      ),
    } as unknown as GatewayBrowserClient;
    await loadAutopilot(host);
    expect(host.autopilot.selectedRunId).toBe("r1");
    expect(host.autopilot.runDetail?.run.id).toBe("r1");
  });
});

describe("Autopilot mutations survive navigation", () => {
  afterEach(() => vi.useRealTimers());
  it.each(
    (["report", "accept", "decline", "pause"] as const).flatMap((action) =>
      (["reset", "linked-reset", "project", "client"] as const).flatMap((navigation) =>
        [false, true].map((reject) => ({ action, navigation, reject })),
      ),
    ),
  )(
    "keeps $action locked through $navigation until settlement (reject=$reject)",
    async ({ action, navigation, reject }) => {
      vi.useFakeTimers();
      const { host } = setup();
      host.hello = {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes: ["operator.approvals"] },
      };
      const listedRoutines = {
        ...routines,
        routines: [{ id: "receipt", state: { paused: false, pausedBy: null } }],
      } as AutopilotRoutinesListResult;
      const proposals = {
        ...autonomy,
        proposals: [
          {
            routineId: "receipt",
            kind: "promote",
            proposed: "L2",
            declined: null,
            acceptBlocker: null,
          },
        ],
      } as AutopilotAutonomyProposalsResult;
      const request = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "autopilot.routines.list") {
          return listedRoutines;
        }
        if (method === "autopilot.autonomy.proposals") {
          return proposals;
        }
        const run = { ...detail.run, projectId: host.projects.selectedId!, workItems: ["item1"] };
        if (method === "autopilot.runs.list") {
          return { runs: [run], total: 1, nextCursor: null };
        }
        if (method === "autopilot.runs.get") {
          return { ...detail, run };
        }
        return stats;
      });
      host.client = { request } as unknown as GatewayBrowserClient;
      const prepare = async () => {
        await inspectAutopilotRun(host, "r1");
        setAutopilotReportReason(host, "item1", "Wrong recipient");
        setAutonomyDeclineReason(host, "receipt", "Reviewed proposal");
        setAutopilotRoutineReason(host, "receipt", "Needs review");
      };
      const write = () =>
        action === "report"
          ? reportAutopilotError(host, "item1")
          : action === "accept"
            ? acceptAutonomy(host, "receipt")
            : action === "decline"
              ? declineAutonomy(host, "receipt")
              : changeAutopilotRoutine(host, "receipt", "pause");
      const method =
        action === "report"
          ? "autopilot.reportError"
          : action === "pause"
            ? "autopilot.pause"
            : `autopilot.autonomy.${action}`;
      await loadAutopilot(host);
      await prepare();
      request.mockClear();
      const pending = deferred<unknown>();
      request.mockImplementationOnce(async () => {
        await pending.promise;
        if (reject) {
          throw new Error("Transport lost");
        }
        return {};
      });
      const writing = write();
      expect(host.autopilot.mutationDelayed).toBe(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(host.autopilot.mutationDelayed).toBe(false);
      // Exercise notice onset both before and after navigation.
      if (!reject) {
        await vi.advanceTimersByTimeAsync(1);
        expect(host.autopilot.mutationDelayed).toBe(true);
      }
      if (navigation === "reset" || navigation === "linked-reset") {
        resetAutopilot(host);
      }
      if (navigation === "linked-reset") {
        host.autopilot = {
          ...host.autopilot,
          projectId: "p1",
          filters: { edition: "business" },
          linkedRun: { id: "r1", itemId: "item1" },
          selectedRunId: "r1",
        };
      }
      if (navigation === "project") {
        host.projects.selectedId = "p2";
      }
      if (navigation === "client") {
        host.client = { request } as unknown as GatewayBrowserClient;
      }
      await loadAutopilot(host);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.autopilot.mutationDelayed).toBe(true);
      autopilotEvent(host, { projectId: host.projects.selectedId });
      await prepare();
      await write();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.autopilot.mutationDelayed).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(host.autopilot.projectId).toBe(host.projects.selectedId);
      expect(host.autopilot.loading).toBe(true);
      expect(host.autopilot.runs).toBeNull();
      if (navigation === "linked-reset") {
        expect(host.autopilot.filters).toEqual({ edition: "business" });
        expect(host.autopilot.linkedRun).toEqual({ id: "r1", itemId: "item1" });
      }
      pending.resolve({});
      await writing;
      expect(host.autopilot.mutationDelayed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(host.autopilot.loading).toBe(false);
      expect(host.autopilot.runs?.runs[0].projectId).toBe(host.projects.selectedId);
      expect(host.autopilot.reportStatus).toBeNull();
      expect(host.autopilot.acceptStatus).toBeNull();
      expect(host.autopilot.declineStatus).toBeNull();
      expect(host.autopilot.routineStatus).toBeNull();
      expect(host.autopilot.reportReasons).toEqual({});
      expect(host.autopilot.declineReasons).toEqual({});
      expect(host.autopilot.routineReasons).toEqual({});
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      await prepare();
      await write();
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.autopilot.mutationDelayed).toBe(false);
    },
  );
});
