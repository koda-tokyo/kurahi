import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_DEPARTMENTS } from "../business-departments";
import { renderBusinessChatEntry } from "./business-chat-entry";

function setup(overrides: Partial<Parameters<typeof renderBusinessChatEntry>[0]> = {}) {
  const node = document.createElement("div");
  document.body.append(node);
  const props = {
    locale: "en",
    projectId: "project-1",
    projectName: "Example company",
    department: BUSINESS_DEPARTMENTS.find((department) => department.id === "finance"),
    disabled: false,
    state: {
      businessChatDraft: "  Review this invoice  ",
      startBusinessChat: vi.fn(async () => {}),
      editBusinessChatDraft: vi.fn(),
    },
    ...overrides,
  };
  render(renderBusinessChatEntry(props), node);
  return { node, props };
}
afterEach(() => document.body.replaceChildren());

describe("Business chat entry", () => {
  it("shows project and department, sends draft and opens an empty conversation explicitly", () => {
    const { node, props } = setup();
    expect(node.textContent).toContain("Example company");
    expect(node.textContent).toContain("Finance & Accounting");
    node.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
    expect(props.state.startBusinessChat).toHaveBeenCalledWith("project-1", "Review this invoice");
    node.querySelector<HTMLButtonElement>(".business-chat-entry__actions [type=button]")!.click();
    expect(props.state.startBusinessChat).toHaveBeenLastCalledWith("project-1", undefined);
  });
  it("uses controlled edits and prompt chips without sending", () => {
    const { node, props } = setup();
    const input = node.querySelector("textarea")!;
    input.value = "Please help";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.state.editBusinessChatDraft).toHaveBeenCalledWith("Please help");
    node.querySelector<HTMLButtonElement>(".business-chat-entry__prompts button")!.click();
    expect(props.state.editBusinessChatDraft).toHaveBeenLastCalledWith(
      "Help me plan today's priorities",
    );
    expect(document.activeElement).toBe(input);
    expect(props.state.startBusinessChat).not.toHaveBeenCalled();
    render(
      renderBusinessChatEntry({
        ...props,
        state: { ...props.state, businessChatDraft: "Retained draft" },
      }),
      node,
    );
    expect(node.querySelector("textarea")!.value).toBe("Retained draft");
  });
  it("sends on Enter while preserving Shift+Enter and IME composition", () => {
    const { node, props } = setup();
    const input = node.querySelector("textarea")!;
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...options });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(props.state.startBusinessChat).not.toHaveBeenCalled();
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(props.state.startBusinessChat).toHaveBeenCalledOnce();
  });
  it("blocks all interaction when unavailable or opening", () => {
    for (const options of [
      { disabled: true },
      { state: {} },
      {
        state: {
          businessChatOpening: true,
          startBusinessChat: vi.fn(async () => {}),
          editBusinessChatDraft: vi.fn(),
        },
      },
    ]) {
      const { node } = setup(options);
      expect(node.querySelector("textarea")!.disabled).toBe(true);
      expect([...node.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    }
  });
  it("disables empty sends and localizes Japanese context and errors", () => {
    const { node } = setup({
      locale: "ja",
      state: {
        businessChatDraft: "  ",
        startBusinessChat: vi.fn(async () => {}),
        editBusinessChatDraft: vi.fn(),
        businessChatError: "接続できません",
      },
    });
    expect(node.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    expect(node.textContent).toContain("財務・経理");
    expect(node.textContent).toContain("エージェントに話しかける");
    expect(node.querySelector('[role="alert"]')?.textContent).toBe("接続できません");
  });
});
