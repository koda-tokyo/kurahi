import fs from "node:fs";
import { describe, expect, it } from "vitest";

function read(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

function codes(source: string, re: RegExp): string[] {
  return [...new Set([...source.matchAll(re)].map((match) => match[1]))].toSorted();
}

// The console names each worksheet plan problem in words; a code it does not list is shown raw.
describe("worksheet plan problem codes", () => {
  it("the console lists exactly the problem codes the gateway reports for a pack plan", () => {
    const raised = codes(
      ["pack-plan.ts", "links.ts", "pack-plan-file.ts"].map(read).join("\n"),
      /code: "([a-z_]+)"/g,
    );
    const block = /const PLAN_PROBLEM_CODES = new Set\(\[([^\]]*)\]\)/.exec(
      read("../../ui/src/ui/views/business.ts"),
    );
    expect(raised.length).toBeGreaterThan(20);
    expect(block).not.toBeNull();
    expect(codes(block![1], /"([a-z_]+)"/g)).toEqual(raised);
  });

  it("each listed code has an English and a Japanese description", () => {
    const i18n = read("../../ui/src/ui/i18n/business.ts");
    const labelled = codes(i18n, /"business\.linked\.plans\.problem\.([a-z_]+)":/g).filter(
      (code) => code !== "separator",
    );
    const raised = codes(
      ["pack-plan.ts", "links.ts", "pack-plan-file.ts"].map(read).join("\n"),
      /code: "([a-z_]+)"/g,
    );
    expect(labelled).toEqual(raised);
    for (const code of raised) {
      expect(i18n.split(`"business.linked.plans.problem.${code}":`).length - 1).toBe(2);
    }
  });
});
