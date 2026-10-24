import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { emptyBusiness } from "../controllers/business";
import { DEFAULT_PROJECTS_STATE } from "../controllers/projects";
import { setLocale } from "../i18n";
import { renderProjects } from "./projects";
describe("Business Project route", () => {
  it("offers the real work queue in a Business Project", () => {
    setLocale("en");
    const project = {
      id: "p1",
      name: "Fictional office",
      folder: "/demo/office",
      templateId: "business-general-affairs",
      mode: "read",
    } as Project;
    const state = {
      business: emptyBusiness(),
      projects: {
        ...DEFAULT_PROJECTS_STATE,
        projects: [project],
        selectedId: "p1",
        view: "business",
      },
      connected: false,
      setProjectView: vi.fn(),
    } as unknown as AppViewState;
    const root = document.createElement("div");
    render(renderProjects(state), root);
    const tab = [...root.querySelectorAll('[role="tab"]')].find(
      (el) => el.textContent?.trim() === "Work queue",
    ) as HTMLElement;
    expect(tab.getAttribute("aria-selected")).toBe("true");
    tab.click();
    expect(state.setProjectView).toHaveBeenCalledWith("business");
    expect(root.querySelector(".business-workspace")).not.toBeNull();
  });
});
