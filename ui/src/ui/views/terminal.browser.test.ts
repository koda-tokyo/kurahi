import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { emptyTerminal } from "../controllers/terminal";
import { setLocale } from "../i18n";
import { renderExecApprovalPrompt } from "./exec-approval";
import { renderTerminal } from "./terminal";
const project = { id: "p1234567890", mode: "plan" } as Project;
function state() {
  return {
    terminal: {
      ...emptyTerminal(),
      session: {
        sessionId: "terminal-1",
        projectId: project.id,
        mode: "plan",
        cwd: "/demo/fictional-plant",
        sandboxed: false,
        limits: { maxLineLength: 4096 },
      },
      synced: true,
    },
    connected: true,
    execApprovalQueue: [],
    runTerminalAction: vi.fn(),
    openProjectTerminal: vi.fn(),
    refreshTerminal: vi.fn(),
    patchTerminalDraft: vi.fn(),
    handleExecApprovalDecision: vi.fn(),
  } as unknown as AppViewState;
}
function root() {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}
afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});
describe("terminal workbench", () => {
  it("renders output as inert text and sends input only on explicit submit", () => {
    const host = state();
    host.terminal.draft = "echo hello";
    host.terminal.events = [
      {
        sessionId: "terminal-1",
        seq: 1,
        ts: 1,
        type: "stdout",
        data: "\x1b[31m<script>alert(1)</script>\x1b[0m",
      },
    ];
    const element = root();
    render(renderTerminal(host, project), element);
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("pre")?.textContent).toBe("<script>alert(1)</script>");
    expect(host.runTerminalAction).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    expect(host.runTerminalAction).toHaveBeenCalledWith("input", project);
  });
  it("disables offline input and warns that commands may still be running", () => {
    const host = state();
    host.connected = false;
    const element = root();
    render(renderTerminal(host, project), element);
    expect(element.textContent).toContain("Commands may still be running");
    expect(element.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect([...element.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
  it("can open another project after closing without leaking the prior transcript", () => {
    const host = state();
    host.terminal.closed = true;
    host.terminal.events = [
      { sessionId: "terminal-1", seq: 1, ts: 1, type: "stdout", data: "private previous output" },
    ];
    const another = { ...project, id: "another" };
    const element = root();
    render(renderTerminal(host, another), element);
    expect(element.textContent).not.toContain("private previous output");
    const button = [...element.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Open terminal"),
    );
    button?.click();
    expect(host.openProjectTerminal).toHaveBeenCalledWith(another);
  });
  it("keeps live sessions bound to their project and explains host execution", () => {
    const host = state();
    const element = root();
    render(renderTerminal(host, project), element);
    expect(element.textContent).toContain("service user's permissions");
    render(renderTerminal(host, { ...project, id: "another" }), element);
    expect(element.textContent).toContain("another project");
    expect(element.querySelector("input")).toBeNull();
  });
  it("shows terminal approvals as once-only and disables offline or expired decisions", () => {
    const host = state();
    host.execApprovalQueue = [
      {
        id: "approval-1",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60000,
        request: { command: "touch demo", sessionKey: "terminal:terminal-1" },
      },
    ];
    const element = root();
    render(renderExecApprovalPrompt(host), element);
    expect(element.textContent).not.toContain("Always allow");
    element.querySelector<HTMLButtonElement>("button")?.click();
    expect(host.handleExecApprovalDecision).toHaveBeenCalledWith("allow-once");
    host.connected = false;
    render(renderExecApprovalPrompt(host), element);
    expect([...element.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    host.connected = true;
    host.execApprovalQueue[0].expiresAtMs = Date.now() - 1;
    render(renderExecApprovalPrompt(host), element);
    expect([...element.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
  it("renders Japanese terminal controls", () => {
    setLocale("ja");
    const element = root();
    render(renderTerminal(state(), project), element);
    expect(element.textContent).toContain("コマンドを停止");
    expect(element.textContent).not.toContain("terminal.");
  });
});
