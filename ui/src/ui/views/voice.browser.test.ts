import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { emptyVoice } from "../controllers/voice";
import { setLocale } from "../i18n";
import { renderVoice } from "./voice";
const project = { id: "p1" } as Project;
afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});
function setup(phase = "idle") {
  const state = {
    connected: true,
    voiceCapture: () => ({}),
    voice: { ...emptyVoice(), phase, projectId: "p1", text: "Review me" },
    startProjectVoice: vi.fn(),
    stopProjectVoice: vi.fn(),
    cancelProjectVoice: vi.fn(),
    patchVoiceText: vi.fn(),
    useVoiceDraft: vi.fn(),
  } as unknown as AppViewState;
  const root = document.createElement("div");
  document.body.append(root);
  return { state, root, draw: () => render(renderVoice(state, project), root) };
}
describe("voice transcript review", () => {
  it("shows honest unavailable state without a native adapter", () => {
    const s = setup();
    s.state.voiceCapture = null;
    s.draw();
    expect(s.root.querySelector("button")?.disabled).toBe(true);
    expect(s.root.textContent).toContain("not available in this app yet");
  });
  it("only opens a draft after an explicit click and allows editing", () => {
    const s = setup("ready");
    s.draw();
    expect(s.state.useVoiceDraft).not.toHaveBeenCalled();
    const input = s.root.querySelector("textarea")!;
    input.value = "Edited draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(s.state.patchVoiceText).toHaveBeenCalledWith("Edited draft");
    [...s.root.querySelectorAll("button")].find((b) => b.textContent?.includes("Open as"))!.click();
    expect(s.state.useVoiceDraft).toHaveBeenCalledWith(project);
    expect(s.root.textContent).toContain("voice cannot approve actions");
  });
  it("offers keyboard-operable finish and discard buttons while listening", () => {
    const s = setup("recording");
    s.draw();
    const buttons = [...s.root.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.includes("Finish"))!.click();
    buttons.find((b) => b.textContent?.includes("Discard"))!.click();
    expect(s.state.stopProjectVoice).toHaveBeenCalledOnce();
    expect(s.state.cancelProjectVoice).toHaveBeenCalledOnce();
    expect(s.root.querySelector("textarea")).toBeNull();
  });
  it("renders Japanese and disables the draft action while disconnected", () => {
    const s = setup("ready");
    setLocale("ja");
    s.state.connected = false;
    s.draw();
    expect(s.root.textContent).toContain("文字起こし");
    expect(
      [...s.root.querySelectorAll("button")].find((b) => b.textContent?.includes("下書きとして"))
        ?.disabled,
    ).toBe(true);
  });
});
