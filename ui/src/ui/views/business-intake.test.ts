import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import { emptyBusiness } from "../controllers/business";
import { setLocale } from "../i18n";
import { renderBusinessIntake } from "./business-intake";

function mount(enabled = true, locale = "en") {
  const root = document.createElement("div");
  document.body.append(root);
  const state = {
    locale,
    business: {
      ...emptyBusiness(),
      config: {
        queues: [
          { id: "expenses", types: ["expense"], name: { en: "Expenses", ja: "経費" } },
          { id: "invoices", types: ["invoice"], name: { en: "Invoices" } },
        ],
      },
      expenseForm: {
        queue: "expenses",
        title: "Training supplies",
        employeeId: "DEMO-42",
        amount: "125.50",
        expenseDate: "2026-10-22",
        category: "Supplies",
        purpose: "Fictional workshop",
        documents: "receipts/supplies.pdf",
      },
    },
    editBusinessExpense: vi.fn(),
    cancelBusinessExpense: vi.fn(),
    createBusinessExpense: vi.fn(),
    acknowledgeExpenseOutcome: vi.fn(),
  } as unknown as AppViewState;
  const update = () => render(renderBusinessIntake(state, enabled), root);
  update();
  return { root, state, update };
}
afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});

describe("Business expense intake", () => {
  it("offers only configured expense queues and sends edits without saving automatically", () => {
    const { root, state } = mount();
    expect(Array.from(root.querySelectorAll("option")).map((option) => option.value)).toEqual([
      "expenses",
    ]);
    const amount = root.querySelector<HTMLInputElement>('[name="amount"]')!;
    amount.value = "250";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.editBusinessExpense).toHaveBeenCalledWith({ amount: "250" });
    expect(state.createBusinessExpense).not.toHaveBeenCalled();
    root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(state.createBusinessExpense).toHaveBeenCalledOnce();
    expect(root.textContent).toContain("does not submit it for approval or make a payment");
  });

  it.each(["pending", "uncertain", "invalid", "removedQueue", "disabled"])(
    "prevents submission when %s",
    (reason) => {
      const { root, state, update } = mount(reason !== "disabled");
      if (reason === "pending") {
        state.business.expensePending = true;
      }
      if (reason === "uncertain") {
        state.business.expenseUncertain = true;
      }
      if (reason === "invalid") {
        state.business.expenseForm!.amount = "NaN";
      }
      if (reason === "removedQueue") {
        state.business.config!.queues = [];
      }
      update();
      expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      root
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(state.createBusinessExpense).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit acknowledgement of an uncertain save", () => {
    const { root, state, update } = mount();
    state.business.expenseUncertain = true;
    state.business.expenseNotice = "Unconfirmed";
    update();
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("Unconfirmed");
    root.querySelector<HTMLButtonElement>(".business-intake-reconcile button")!.click();
    expect(state.acknowledgeExpenseOutcome).toHaveBeenCalledOnce();
    expect(state.createBusinessExpense).not.toHaveBeenCalled();
  });

  it("escapes field content and renders Japanese labels", () => {
    const { root, state, update } = mount(true, "ja");
    state.business.expenseForm!.purpose = '<img src=x onerror="alert(1)">';
    setLocale("ja");
    update();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('[name="purpose"]')!.value).toContain("<img");
    expect(root.textContent).toContain("経費申請");
    expect(root.textContent).toContain("申請を保存");
    expect(root.querySelector("select")!.selectedOptions[0].textContent).toContain("経費");
    expect(root.textContent).not.toContain("business.intake.");
  });
});

describe("saved expense confirmation", () => {
  it("renders read-only submission confirmation and blocks a refreshed revision", () => {
    const { root, state, update } = mount();
    state.business.expenseForm!.target = { id: "saved", revision: 7, action: "submit" };
    state.business.selectedId = "saved";
    state.business.item = { id: "saved", revision: 7, status: "new" } as NonNullable<
      typeof state.business.item
    >;
    update();
    expect(root.querySelector("fieldset")!.disabled).toBe(true);
    expect(root.textContent).toContain("Request revision: 7");
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(state.createBusinessExpense).not.toHaveBeenCalled();
    state.business.item.revision = 8;
    update();
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(state.createBusinessExpense).not.toHaveBeenCalled();
    expect(root.textContent).toContain("request changed");
  });
});
