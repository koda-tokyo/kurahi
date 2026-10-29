import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORK_ITEM_LINKED_PLAN_PROBLEMS,
  WORK_ITEM_LINKED_REFUSALS,
} from "../../packages/client/src/workitems.js";

function codes(file: string, re: RegExp): Set<string> {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  return new Set([...source.matchAll(re)].map((match) => match[1]));
}

// The typed client lists every code a linked case refusal can carry, so a UI can map each one.
describe("linked case refusal codes", () => {
  it("the client lists exactly the codes the linked case store refuses with", () => {
    const raised = codes("links-store.ts", /refuse\(\s*"([a-z_]+)"/g);
    expect(raised.size).toBeGreaterThan(10);
    expect([...raised].toSorted()).toEqual([...WORK_ITEM_LINKED_REFUSALS].toSorted());
  });

  it("the client lists exactly the plan problem codes validation reports", () => {
    const raised = codes("links.ts", /code: "([a-z_]+)"/g);
    expect(raised.size).toBeGreaterThan(5);
    expect([...raised].toSorted()).toEqual([...WORK_ITEM_LINKED_PLAN_PROBLEMS].toSorted());
  });
});
