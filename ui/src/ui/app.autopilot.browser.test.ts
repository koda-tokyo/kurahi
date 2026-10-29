import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "./app-view-state";
import type { Project, ProjectsState } from "./controllers/projects";
import { KoLoApp } from "./app";
import { autopilotEvent, emptyAutopilot } from "./controllers/autopilot";
import { emptyBusiness } from "./controllers/business";
import { DEFAULT_PROJECTS_STATE } from "./controllers/projects";
import { setLocale, t } from "./i18n";
import { renderProjects } from "./views/projects";

afterEach(() => setLocale("en"));

describe("shared Autopilot Project route", () => {
  it.each([
    "industry-legacy-modernisation",
    "business-company-operations",
    "research-academic",
    null,
  ])("exposes the same read-only tab for template %s in both locales", (templateId) => {
    for (const locale of ["en", "ja"]) {
      setLocale(locale);
      const project = {
        id: "p1",
        name: "Fictional project",
        folder: "/demo/project",
        templateId,
        mode: "read",
      } as Project;
      const state = {
        locale,
        autopilot: emptyAutopilot(),
        projects: {
          ...DEFAULT_PROJECTS_STATE,
          projects: [project],
          selectedId: project.id,
          view: "autopilot",
        },
        connected: false,
        setProjectView: vi.fn(),
      } as unknown as AppViewState;
      const root = document.createElement("div");
      render(renderProjects(state), root);
      const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
      const tab = tabs.find((el) => el.textContent?.trim() === t("autopilot.title"));
      expect(tab).toBeDefined();
      expect(tab!.getAttribute("aria-selected")).toBe("true");
      tab!.click();
      expect(state.setProjectView).toHaveBeenCalledWith("autopilot");
      expect(root.querySelector('button[type="submit"]')).toBeNull();
    }
  });

  it("opening the tab reads only its Project and changing Project clears its state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "autopilot.routines.list") {
        return {
          routines: [],
          catalogue: [],
          editions: {},
          flags: [],
          digest: "fixture",
          source: { kind: "none", path: null },
          error: null,
        };
      }
      if (method === "autopilot.runs.list") {
        return { runs: [], total: 0, nextCursor: null };
      }
      if (method === "autopilot.stats") {
        return {
          routines: [],
          areas: [],
          from: null,
          to: null,
          totals: {
            runs: 0,
            failedRuns: 0,
            items: 0,
            prepared: 0,
            acted: 0,
            escalated: 0,
            handled: 0,
            correctedByPerson: 0,
            minutesSaved: null,
          },
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const host = {
      connected: true,
      client: { request },
      tab: "projects",
      autopilot: emptyAutopilot(),
      business: emptyBusiness(),
      projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "chat" },
      patchProjects(this: KoLoApp, update: Partial<ProjectsState>) {
        this.projects = { ...this.projects, ...update };
      },
    } as unknown as KoLoApp;
    void KoLoApp.prototype.setProjectView.call(host, "autopilot");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual([
      "autopilot.autonomy.proposals",
      "autopilot.brief.get",
      "autopilot.routines.list",
      "autopilot.runs.list",
      "autopilot.stats",
    ]);
    for (const call of request.mock.calls) {
      expect((call as unknown[])[1]).toMatchObject({ projectId: "p1" });
    }
    KoLoApp.prototype.openProject.call(host, "p2");
    expect(host.projects.selectedId).toBe("p2");
    expect(host.autopilot).toEqual(emptyAutopilot());
    await Promise.resolve();
    expect(host.autopilot).toEqual(emptyAutopilot());
    expect(request).toHaveBeenCalledTimes(5);
  });
});

describe("Business originating-run navigation", () => {
  function linkedHost() {
    const request = vi.fn(async (method: string) => {
      if (method === "autopilot.runs.get") {
        return {
          run: { id: "origin", projectId: "p1", workItems: ["item1"] },
          evidence: { ok: false, problems: [] },
        };
      }
      if (method === "autopilot.runs.list") {
        return { runs: [], total: 0, nextCursor: null };
      }
      return {};
    });
    const host = {
      connected: true,
      client: { request },
      tab: "projects",
      autopilot: emptyAutopilot(),
      business: {
        ...emptyBusiness(),
        projectId: "p1",
        selectedId: "item1",
        item: {
          id: "item1",
          projectId: "p1",
          createdBy: "autopilot:receipts",
          source: { fields: { autopilotRun: "origin" } },
        },
      },
      projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
      updateComplete: Promise.resolve(),
      querySelector: vi.fn(() => null),
      patchProjects(this: KoLoApp, update: Partial<ProjectsState>) {
        this.projects = { ...this.projects, ...update };
      },
      // oxlint-disable-next-line typescript/unbound-method -- the stub host calls it with itself as `this`
      setProjectView: KoLoApp.prototype.setProjectView,
    } as unknown as KoLoApp;
    return { host, request };
  }
  it("loads the Project and then opens an originating run outside the current page", async () => {
    const { host, request } = linkedHost();
    await KoLoApp.prototype.openBusinessRun.call(host);
    expect(host.projects.view).toBe("autopilot");
    expect(request).toHaveBeenCalledWith("autopilot.runs.get", { projectId: "p1", id: "origin" });
    expect(host.autopilot.runDetail?.run.id).toBe("origin");
    expect(host.autopilot.runDetail?.evidence.ok).toBe(false);
  });
  it.each(["project", "stale", "loading", "ordinary"])(
    "rejects %s Business links before navigation",
    async (kind) => {
      const { host, request } = linkedHost();
      if (kind === "project") {
        host.projects.selectedId = "p2";
      }
      if (kind === "stale") {
        host.business.selectedId = "item2";
      }
      if (kind === "loading") {
        host.business.detailLoading = true;
      }
      if (kind === "ordinary") {
        host.business.item!.createdBy = "person:alice";
      }
      await KoLoApp.prototype.openBusinessRun.call(host);
      expect(request).not.toHaveBeenCalled();
      expect(host.projects.view).toBe("business");
    },
  );
  it("keeps the originating-run intent through a deferred queued refresh", async () => {
    const { host, request } = linkedHost();
    const original = request.getMockImplementation()!;
    let reads = 0;
    let finish!: (value: { runs: never[]; total: number; nextCursor: null }) => void;
    request.mockImplementation(async (method) => {
      if (method === "autopilot.runs.list" && ++reads === 2) {
        return new Promise<{ runs: never[]; total: number; nextCursor: null }>((resolve) => {
          finish = resolve;
        });
      }
      return original(method);
    });
    const pending = KoLoApp.prototype.openBusinessRun.call(host);
    autopilotEvent(host, { projectId: "p1" });
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(host.autopilot.loading).toBe(true);
    expect(host.autopilot.linkedRun).toEqual({ id: "origin", itemId: "item1" });
    expect(request.mock.calls.some(([method]) => method === "autopilot.runs.get")).toBe(false);
    finish({ runs: [], total: 0, nextCursor: null });
    await pending;
    expect(host.autopilot.runDetail?.run.id).toBe("origin");
    expect(request.mock.calls.filter(([method]) => method === "autopilot.runs.get")).toHaveLength(
      1,
    );
  });
  it.each(["project", "tab", "awayBack"])(
    "does not open a linked run after %s navigation during the list read",
    async (change) => {
      const { host, request } = linkedHost();
      const pending = KoLoApp.prototype.openBusinessRun.call(host);
      if (change === "project") {
        host.projects = { ...host.projects, selectedId: "p2" };
      }
      if (change === "tab") {
        host.tab = "chat";
      }
      if (change === "awayBack") {
        void host.setProjectView("chat");
        void host.setProjectView("autopilot");
      }
      await pending;
      expect(request.mock.calls.some(([method]) => method === "autopilot.runs.get")).toBe(false);
    },
  );
});
