import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderBusinessChatContext } from "./business-chat-context";
afterEach(() => document.body.replaceChildren());
function setup(sessionKey: string, locale = "en") {
  const node = document.createElement("div");
  document.body.append(node);
  const onOpenWork = vi.fn();
  render(
    renderBusinessChatContext({ sessionKey, locale, projectName: "Example company", onOpenWork }),
    node,
  );
  return { node, onOpenWork };
}
describe("Business conversation context", () => {
  it("shows project, department and routed agent and opens work", () => {
    const { node, onOpenWork } = setup("agent:finance-assistant:proj-p1234567890-deptfinance0abc");
    expect(node.textContent).toContain("Example company · Finance & Accounting");
    expect(node.textContent).toContain("Agent: finance-assistant");
    node.querySelector("button")!.click();
    expect(onOpenWork).toHaveBeenCalledOnce();
  });
  it("localizes the context to Japanese", () => {
    const { node } = setup("agent:hr-assistant:proj-p1234567890-depthr0abc", "ja");
    expect(node.textContent).toContain("人事");
    expect(node.querySelector("button")!.textContent).toBe("部門の業務");
  });
  it("does not label ordinary chats or invalid department sessions", () => {
    for (const key of [
      "agent:main:main",
      "agent:main:proj-p1234567890-abc",
      "agent:main:proj-invalid-deptfinance0abc",
      "agent:main:proj-p1234567890-deptunknown0abc",
    ]) {
      expect(setup(key).node.querySelector("aside")).toBeNull();
    }
  });
});
