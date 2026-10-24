import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { setLocale } from "../i18n";
import { renderIndustrialModernisation } from "./industrial-modernisation";

const project = {
  id: "pindustrial1",
  plugins: ["legacy-analyzer"],
  name: "Factory modernization",
  folder: "/demo/fictional-plant",
  mode: "plan",
  rules: { artifactApprovalRequired: true },
  templateId: "industry-legacy-modernisation",
} as Project;

afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});

describe("Industrial modernization workbench", () => {
  it("renders one role, one lifecycle and all nine domains", () => {
    const root = document.createElement("div");
    render(
      renderIndustrialModernisation(
        { locale: "en", connected: true, startProjectChat: vi.fn() } as unknown as AppViewState,
        project,
      ),
      root,
    );

    expect(root.textContent).toContain("Industrial Modernization Engineer");
    expect(root.textContent).toContain("Not yet measured");
    expect(root.textContent).not.toContain("99.99%");
    expect(root.querySelectorAll(".industrial-lifecycle span")).toHaveLength(7);
    expect(root.querySelectorAll(".industrial-capability")).toHaveLength(9);
    expect(root.querySelectorAll(".industrial-pack")).toHaveLength(5);
    expect(root.textContent).toContain("COBOL, copybooks and JCL");
    expect(root.textContent).toContain("Industrial cybersecurity");
    expect(root.textContent).toContain("Configured, not verified");
    expect(root.textContent).toContain("Disabled");
    expect(root.textContent).toContain("Planned");
  });

  it("starts ready packs and prevents unavailable packs from claiming operation", () => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "en", connected: true, startProjectChat } as unknown as AppViewState,
        project,
      ),
      root,
    );

    const analysis = root.querySelector<HTMLButtonElement>('[data-pack="analysis"] button');
    const controls = root.querySelector<HTMLButtonElement>('[data-pack="controls"] button');
    const cybersecurity = root.querySelector<HTMLButtonElement>(
      '[data-pack="cybersecurity"] button',
    );

    analysis?.click();
    expect(startProjectChat).toHaveBeenCalledWith(
      project.id,
      expect.stringMatching(/verified findings from inference/i),
    );
    expect(controls?.disabled).toBe(true);
    expect(cybersecurity?.disabled).toBe(true);
  });

  it("starts the selected assessment in the same project", () => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "en", connected: true, startProjectChat } as unknown as AppViewState,
        project,
      ),
      root,
    );

    const buttons = root.querySelectorAll<HTMLButtonElement>(".industrial-capability button");
    buttons[1]?.click();
    expect(startProjectChat).toHaveBeenCalledOnce();
    expect(startProjectChat).toHaveBeenCalledWith(
      project.id,
      expect.stringMatching(/FORTRAN programs.*verified and unverified/i),
    );
  });

  it("disables planned domains even when connected", () => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "en", connected: true, startProjectChat } as unknown as AppViewState,
        project,
      ),
      root,
    );
    for (const id of ["batch", "plc", "maintenance", "cybersecurity"]) {
      const card = root.querySelector(`[data-capability="${id}"]`)!;
      expect(card.textContent).toContain("Planned");
      const button = card.querySelector("button")!;
      expect(button.disabled).toBe(true);
      button.click();
      button.dispatchEvent(new MouseEvent("click"));
    }
    expect(startProjectChat).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".industrial-capability .ent-status--active")).toHaveLength(5);
  });

  it("blocks assessment and pack actions without a gateway and localizes the mode", () => {
    setLocale("ja");
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "ja", connected: false, startProjectChat } as unknown as AppViewState,
        project,
      ),
      root,
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      ".industrial-capability button, .industrial-pack button",
    )) {
      expect(button.disabled).toBe(true);
      button.click();
      button.dispatchEvent(new MouseEvent("click"));
    }
    expect(startProjectChat).not.toHaveBeenCalled();
    expect(root.querySelector(".industrial-context")?.textContent).toContain("計画");
    expect(root.textContent).toContain("ゲートウェイ接続が必要");
  });

  it("routes available workbench tabs and keeps unimplemented controls disabled", () => {
    const root = document.createElement("div");
    const setProjectView = vi.fn();
    render(
      renderIndustrialModernisation(
        {
          locale: "en",
          connected: true,
          setProjectView,
          startProjectChat: vi.fn(),
        } as unknown as AppViewState,
        project,
      ),
      root,
    );

    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".industrial-tab")];
    expect(tabs.map((tab) => tab.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Chat",
      "Terminal",
      "Timeline",
      "Files",
      "Artifacts",
      "Assets",
    ]);
    expect(tabs[1]?.disabled).toBe(false);
    tabs[1]?.click();
    expect(setProjectView).toHaveBeenCalledWith("terminal");
    expect(root.querySelector<HTMLButtonElement>(".industrial-voice")?.disabled).toBe(true);
    tabs[2]?.click();
    expect(setProjectView).toHaveBeenCalledWith("history");
    expect(root.textContent).toContain("/demo/fictional-plant");
  });
});

describe("Industrial guided document generation", () => {
  it.each(["en", "ja"])("prepares both requests in the selected project (%s)", (locale) => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale, connected: true, startProjectChat } as unknown as AppViewState,
        project,
      ),
      root,
    );
    for (const tool of ["legacy_design_doc", "legacy_wave_plan"]) {
      const button = root.querySelector<HTMLButtonElement>(`[data-document-tool="${tool}"]`)!;
      expect(button.disabled).toBe(false);
      button.click();
      expect(startProjectChat).toHaveBeenLastCalledWith(project.id, expect.stringContaining(tool));
      expect(startProjectChat).toHaveBeenLastCalledWith(
        project.id,
        expect.stringContaining(JSON.stringify({ path: project.folder, lang: locale })),
      );
    }
    expect(startProjectChat).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".industrial-panel--documents")?.textContent).toContain(
      locale === "ja" ? "自動で成果物として保存されません" : "not automatically saved as artifacts",
    );
  });

  it.each([
    { connected: false, folder: project.folder },
    { connected: true, folder: "" },
    { connected: true, folder: "   " },
  ])("blocks generation without connection or root: %j", ({ connected, folder }) => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "en", connected, startProjectChat } as unknown as AppViewState,
        { ...project, folder },
      ),
      root,
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-document-tool]")) {
      expect(button.disabled).toBe(true);
      button.click();
      button.dispatchEvent(new MouseEvent("click"));
    }
    expect(startProjectChat).not.toHaveBeenCalled();
    expect(root.querySelector(".industrial-panel--documents")?.textContent).toContain(
      "A gateway connection and a project folder are required",
    );
  });
});

it("blocks document requests when the project explicitly disables the analyzer", () => {
  const root = document.createElement("div");
  const startProjectChat = vi.fn();
  render(
    renderIndustrialModernisation(
      {
        locale: "en",
        connected: true,
        startProjectChat,
        projects: { templates: [{ id: project.templateId, plugins: ["legacy-analyzer"] }] },
      } as unknown as AppViewState,
      { ...project, plugins: [] },
    ),
    root,
  );
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-document-tool]")) {
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new MouseEvent("click"));
  }
  expect(startProjectChat).not.toHaveBeenCalled();
  expect(root.textContent).toContain("Legacy analysis is not confirmed enabled");
});

it.each([
  { plugins: [], folder: project.folder },
  { plugins: undefined, folder: project.folder },
  { plugins: ["legacy-analyzer"], folder: "" },
])(
  "blocks deterministic assessments without effective analyzer and root: %j",
  ({ plugins, folder }) => {
    const root = document.createElement("div");
    const startProjectChat = vi.fn();
    render(
      renderIndustrialModernisation(
        { locale: "en", connected: true, startProjectChat } as unknown as AppViewState,
        { ...project, plugins, folder },
      ),
      root,
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      ".industrial-capability button",
    )) {
      expect(button.disabled).toBe(true);
      button.dispatchEvent(new MouseEvent("click"));
    }
    expect(startProjectChat).not.toHaveBeenCalled();
    expect(root.querySelector(".industrial-panel--capabilities")?.textContent).toContain(
      folder
        ? "Legacy analysis is not confirmed enabled"
        : "A gateway connection and a project folder are required",
    );
  },
);
