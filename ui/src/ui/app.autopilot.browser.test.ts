import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "./app-view-state";
import type { Project, ProjectsState } from "./controllers/projects";
import { KoLoApp } from "./app";
import { emptyAutopilot } from "./controllers/autopilot";
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
    KoLoApp.prototype.setProjectView.call(host, "autopilot");
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
