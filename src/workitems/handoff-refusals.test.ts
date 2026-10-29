import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { WORK_ITEM_HANDOFF_REFUSALS } from "../../packages/client/src/workitems.js";

// The typed client lists every code a hand-off refusal can carry, so a UI can map each one.
describe("hand-off refusal codes", () => {
  it("the client lists every code the hand-off engine refuses with", () => {
    const raised = new Set<string>();
    for (const file of ["handoff.ts", "handoff-store.ts"]) {
      const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
      for (const match of source.matchAll(/refuse\(\s*"([a-z_]+)"/g)) {
        raised.add(match[1]);
      }
    }
    expect(raised.size).toBeGreaterThan(10);
    const listed = new Set<string>(WORK_ITEM_HANDOFF_REFUSALS);
    expect([...raised].filter((code) => !listed.has(code))).toEqual([]);
    const engineListed = [...listed].filter((code) => code.startsWith("handoff_"));
    expect(engineListed.filter((code) => !raised.has(code))).toEqual([]);
  });
});
