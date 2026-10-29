import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import { DEFAULT_ARTIFACTS_STATE, type Artifact } from "../controllers/artifacts";
import { setLocale } from "../i18n";
import { renderArtifactPanel } from "./artifacts";

afterEach(() => document.body.replaceChildren());

it("keeps version and comparison selections aligned with displayed content on first render and changes", () => {
  setLocale("en");
  const artifact: Artifact = {
    id: "review-example",
    title: "Review example",
    type: "document",
    format: "md",
    projectId: null,
    status: "review",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    history: [],
    versions: [1, 2, 3].map((version) => ({
      version,
      sha256: "a".repeat(64),
      size: 5,
      createdAt: "2026-01-01T00:00:00Z",
      createdByUser: "reviewer",
      createdByAgent: null,
      sourceSession: null,
      note: null,
    })),
  };
  const state = {
    locale: "en",
    artifacts: {
      ...DEFAULT_ARTIFACTS_STATE,
      panelOpen: true,
      current: artifact,
      currentVersion: 2,
      content: "second",
      compareVersion: 1,
      compareContent: "first",
    },
    patchArtifacts: vi.fn(),
    setArtifactStatus: vi.fn(),
    openArtifactPanel: vi.fn(),
    compareArtifact: vi.fn(),
    saveArtifactVersion: vi.fn(),
    openChatSession: vi.fn(),
  } as unknown as AppViewState;
  const root = document.createElement("div");
  document.body.append(root);
  render(renderArtifactPanel(state), root);
  const selected = () => [...root.querySelectorAll("select")].map((el) => el.value);
  expect(selected()).toEqual(["2", "1"]);
  expect(root.querySelector(".ent-diff")?.textContent).toContain("second");

  state.artifacts.currentVersion = 3;
  state.artifacts.content = "third";
  state.artifacts.compareVersion = 2;
  state.artifacts.compareContent = "second";
  render(renderArtifactPanel(state), root);
  expect(selected()).toEqual(["3", "2"]);
  expect(root.querySelector(".ent-diff")?.textContent).toContain("third");

  state.artifacts.compareVersion = null;
  state.artifacts.compareContent = null;
  render(renderArtifactPanel(state), root);
  expect(selected()).toEqual(["3", ""]);
  expect(root.querySelector(".ent-diff")).toBeNull();
});
