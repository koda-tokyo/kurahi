import { describe, expect, it } from "vitest";
import type { LinkedCasePlan, LinkedCaseStep } from "./links.js";
import { LINKED_PLAN_MAX_STEPS, linkedCaseProgress, validateLinkedPlan } from "./links.js";

const step = (key: string, department: string, dependsOn: string[] = []): LinkedCaseStep => ({
  key,
  department: department as LinkedCaseStep["department"],
  title: { en: key },
  dependsOn,
});

// Onboarding: HR → IT equipment + Procurement → General Affairs desk → IT access → HR close.
const onboarding: LinkedCasePlan = {
  steps: [
    step("hr-intake", "hr"),
    step("it-equipment", "it", ["hr-intake"]),
    step("purchase", "procurement", ["hr-intake"]),
    step("desk", "admin", ["it-equipment", "purchase"]),
    step("it-access", "it", ["desk"]),
    step("hr-close", "hr", ["it-access"]),
  ],
};

describe("validateLinkedPlan", () => {
  it("accepts the onboarding plan, including a department used twice", () => {
    expect(validateLinkedPlan(onboarding)).toEqual([]);
  });

  it("reports structural problems", () => {
    expect(validateLinkedPlan({ steps: [] })).toEqual([{ code: "empty" }]);
    const problems = validateLinkedPlan({
      steps: [step("a", "hr", ["a", "ghost"]), step("a", "hr"), step("Bad Key", "nowhere")],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        { code: "self_dependency", key: "a" },
        { code: "unknown_dependency", key: "a", dependsOn: "ghost" },
        { code: "duplicate_key", key: "a" },
        { code: "bad_key", key: "Bad Key" },
        { code: "bad_department", key: "Bad Key" },
      ]),
    );
    expect(problems.some((p) => p.code === "cycle")).toBe(false);
  });

  it("finds a dependency cycle", () => {
    const problems = validateLinkedPlan({
      steps: [step("a", "hr", ["c"]), step("b", "it", ["a"]), step("c", "admin", ["b"])],
    });
    expect(problems).toEqual([{ code: "cycle", keys: ["a", "c", "b", "a"] }]);
  });

  it("refuses malformed steps and dependency lists instead of reading them as no dependencies", () => {
    const steps = [
      null,
      { ...step("b", "it"), dependsOn: "a" },
      { ...step("c", "it"), dependsOn: [1] },
      { key: "d", department: "hr", title: { en: "d" } },
    ] as unknown as LinkedCaseStep[];
    expect(validateLinkedPlan({ steps })).toEqual([
      { code: "bad_step", index: 0 },
      { code: "bad_dependencies", key: "b" },
      { code: "bad_dependencies", key: "c" },
      { code: "bad_dependencies", key: "d" },
    ]);
    expect(() => linkedCaseProgress({ steps }, {})).toThrow(/bad_step/);
    const noKey = [{ department: "hr", title: {}, dependsOn: [] }] as unknown as LinkedCaseStep[];
    expect(validateLinkedPlan({ steps: noKey })).toEqual([{ code: "bad_key", key: undefined }]);
  });

  it("refuses a step without a readable title", () => {
    const steps = [
      { key: "a", department: "hr", dependsOn: [] },
      { ...step("b", "it"), title: { en: 3 } },
      { ...step("c", "it"), title: ["c"] },
      { ...step("d", "it"), title: {} },
    ] as unknown as LinkedCaseStep[];
    expect(validateLinkedPlan({ steps })).toEqual([
      { code: "bad_step", index: 0 },
      { code: "bad_step", index: 1 },
      { code: "bad_step", index: 2 },
    ]);
  });

  it("caps the number of steps", () => {
    const steps = Array.from({ length: LINKED_PLAN_MAX_STEPS + 1 }, (_, i) => step(`s${i}`, "hr"));
    expect(validateLinkedPlan({ steps })).toEqual([
      { code: "too_many_steps", max: LINKED_PLAN_MAX_STEPS },
    ]);
  });
});

describe("linkedCaseProgress", () => {
  const states = (p: ReturnType<typeof linkedCaseProgress>) =>
    Object.fromEntries(p.steps.map((s) => [s.key, s.state]));

  it("opens only the first step of a new case", () => {
    const p = linkedCaseProgress(onboarding, {});
    expect(p.ready).toEqual(["hr-intake"]);
    expect(states(p)["desk"]).toBe("waiting");
    expect(p).toMatchObject({ done: 0, total: 6, complete: false, blocked: false });
  });

  it("opens parallel steps once their shared dependency is done, and joins them", () => {
    let p = linkedCaseProgress(onboarding, { "hr-intake": "done" });
    expect(p.ready).toEqual(["it-equipment", "purchase"]);
    p = linkedCaseProgress(onboarding, {
      "hr-intake": "done",
      "it-equipment": "done",
      purchase: "awaiting_review",
    });
    expect(p.ready).toEqual([]);
    expect(states(p)).toMatchObject({ purchase: "open", desk: "waiting" });
    p = linkedCaseProgress(onboarding, {
      "hr-intake": "done",
      "it-equipment": "done",
      purchase: "done",
    });
    expect(p.ready).toEqual(["desk"]);
  });

  it("completes only when every step is done", () => {
    const all = Object.fromEntries(onboarding.steps.map((s) => [s.key, "done" as const]));
    expect(linkedCaseProgress(onboarding, all)).toMatchObject({ done: 6, complete: true });
    expect(linkedCaseProgress(onboarding, { ...all, "hr-close": "awaiting_review" }).complete).toBe(
      false,
    );
  });

  it("a cancelled step is not done and leaves its dependants stuck", () => {
    const p = linkedCaseProgress(onboarding, {
      "hr-intake": "done",
      "it-equipment": "done",
      purchase: "cancelled",
    });
    expect(states(p)).toMatchObject({
      purchase: "cancelled",
      desk: "stuck",
      "it-access": "stuck",
      "hr-close": "stuck",
    });
    expect(p).toMatchObject({ ready: [], complete: false, blocked: true });
  });

  it("ignores status for keys that are not in the plan and inherited properties", () => {
    const status = Object.create({ "hr-intake": "done" }) as Record<string, "done">;
    status.unrelated = "done";
    expect(linkedCaseProgress(onboarding, status).ready).toEqual(["hr-intake"]);
  });

  it("refuses an invalid plan", () => {
    expect(() => linkedCaseProgress({ steps: [step("a", "hr", ["a"])] }, {})).toThrow(
      /self_dependency/,
    );
  });
});
