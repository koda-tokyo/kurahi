// The kurahi-legacy server against a temporary copy of the payroll demo pack (the pack the
// legacy-template e2e test uses), without its answer keys. Skipped when the pack is not present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connect } from "./test-project.js";

const PACK =
  process.env.KURAHI_LEGACY_DEMO_PACK ??
  path.join(os.userInfo().homedir, "kurahi-demo-packs", "industry-legacy-cobol");
const hasPack = fs.existsSync(path.join(PACK, "source", "cobol", "PAYCALC.cbl"));

describe.skipIf(!hasPack)("kurahi-legacy on the payroll demo pack", () => {
  it("indexes the pack and cites PAYCALC rule candidates at path:line", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mcp-pack-"));
    fs.cpSync(PACK, root, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("_answer-keys"),
    });
    const s = await connect({ root });
    const built = await s.call("legacy_index_build");
    expect(built.structured.result.counts.programs).toBeGreaterThanOrEqual(4);
    const r = await s.call("legacy_rules", { program: "PAYCALC" });
    const cands = r.structured.result.candidates as Array<{ at: string }>;
    expect(cands.length).toBeGreaterThan(0);
    // Candidates sit in the program or in the copybooks it includes; each one is citable.
    expect(cands.every((c) => /^source\/(cobol|copybook)\/[A-Z]+\.(cbl|cpy):\d+$/.test(c.at))).toBe(
      true,
    );
    expect(cands.some((c) => c.at.startsWith("source/cobol/PAYCALC.cbl:"))).toBe(true);
    const dict = await s.call("legacy_dictionary", { copybook: "EMPREC" });
    expect(dict.structured.result.entries.length).toBeGreaterThan(0);
    await s.close();
  });
  it("serves the design document and the wave plan for the pack", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mcp-pack-doc-"));
    fs.cpSync(PACK, root, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("_answer-keys"),
    });
    const s = await connect({ root });
    const doc = await s.call("legacy_design_doc", { lang: "en", section: "crud" });
    const parts = doc.structured.result.parts as Array<{ section: string; markdown: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].markdown).toMatch(/\.(cbl|cpy|jcl):\d+/i);
    const plan = await s.call("legacy_wave_plan", { lang: "ja" });
    expect(plan.structured.result.plan.waves.length).toBeGreaterThan(0);
    expect(plan.structured.result.markdown.length).toBeGreaterThan(0);
  });
});
