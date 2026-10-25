import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBusiness } from "../controllers/business";
import { renderBusinessWorkIntake } from "./business-work-intake";
const roots: HTMLElement[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    render(null, root);
    root.remove();
  }
});
function fixture(locale = "en") {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const state = {
    locale,
    business: {
      ...emptyBusiness(),
      queue: "office",
      config: {
        queues: [{ id: "office", name: { en: "Office", ja: "総務" }, types: ["request", "case"] }],
        error: null,
      } as ReturnType<typeof emptyBusiness>["config"],
      workForm: {
        queue: "office",
        type: "request" as const,
        title: "Visitor",
        description: "Prepare reception",
        requester: "Office team",
      },
    },
    editBusinessWork: vi.fn(),
    cancelBusinessWork: vi.fn(),
    createBusinessWork: vi.fn(),
    acknowledgeBusinessWorkOutcome: vi.fn(),
  };
  render(renderBusinessWorkIntake(state), root);
  return { root, state };
}
describe("work intake form", () => {
  it("offers only configured types and requires an explicit submit", () => {
    const { root, state } = fixture();
    expect([...root.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "request",
      "case",
    ]);
    expect(root.querySelector<HTMLInputElement>('[name="queue"]')?.readOnly).toBe(true);
    expect(state.createBusinessWork).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Confirm and create request");
    expect(root.textContent).toContain("Existing Project file references (optional)");
    expect(root.textContent).toContain("does not upload");
    const refs = root.querySelector<HTMLTextAreaElement>('[name="documents"]')!;
    refs.value = "requests/brief.pdf";
    refs.dispatchEvent(new Event("input"));
    expect(state.editBusinessWork).toHaveBeenCalledWith({ documents: "requests/brief.pdf" });
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(state.createBusinessWork).toHaveBeenCalledTimes(1);
  });
  it("locks form and prevents submission while pending", () => {
    const { root, state } = fixture();
    state.business.workPending = true;
    render(renderBusinessWorkIntake(state), root);
    expect(root.querySelector("fieldset")?.disabled).toBe(true);
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(state.createBusinessWork).not.toHaveBeenCalled();
  });
  it("renders Japanese labels and explicit reconciliation", () => {
    const { root, state } = fixture("ja");
    expect(root.textContent).toContain("案件の新規作成");
    expect(root.textContent).toContain("既存のプロジェクトファイル参照（任意）");
    state.business.workUncertain = true;
    state.business.workNotice = "結果を確認できません";
    render(renderBusinessWorkIntake(state), root);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("結果を確認できません");
    root.querySelector<HTMLButtonElement>(".business-intake-reconcile button")!.click();
    expect(state.acknowledgeBusinessWorkOutcome).toHaveBeenCalledOnce();
  });
});
