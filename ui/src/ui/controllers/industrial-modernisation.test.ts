import { describe, expect, it } from "vitest";
import {
  INDUSTRIAL_CAPABILITIES,
  industrialDocumentPrompt,
  industrialAnalyzerEnabled,
  INDUSTRIAL_LIFECYCLE,
  isIndustrialProject,
} from "./industrial-modernisation";

describe("Industrial Modernization Engineer", () => {
  it("uses one lifecycle across the nine requested domains", () => {
    expect(INDUSTRIAL_LIFECYCLE).toHaveLength(7);
    expect(INDUSTRIAL_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "cobol-jcl",
      "fortran",
      "pli",
      "java",
      "databases",
      "batch",
      "plc",
      "maintenance",
      "cybersecurity",
    ]);
  });

  it("reports the six implemented engines and keeps the three future domains planned", () => {
    expect(
      INDUSTRIAL_CAPABILITIES.filter((capability) => capability.status === "deterministic").map(
        (capability) => capability.id,
      ),
    ).toEqual(["cobol-jcl", "fortran", "pli", "java", "databases", "plc"]);
    expect(
      INDUSTRIAL_CAPABILITIES.filter((capability) => capability.status === "planned").map(
        (capability) => capability.id,
      ),
    ).toEqual(["batch", "maintenance", "cybersecurity"]);
  });

  it("appears only in the industrial project configuration", () => {
    expect(isIndustrialProject({ templateId: "industry-legacy-modernisation" })).toBe(true);
    expect(isIndustrialProject({ templateId: "professional" })).toBe(false);
    expect(isIndustrialProject({ templateId: null })).toBe(false);
  });
});

describe("Industrial document requests", () => {
  it("quotes the project folder and requests the matching language and tool", () => {
    const folder = '/demo/plant "A"\\source';
    for (const locale of ["ja", "en"]) {
      for (const tool of ["legacy_design_doc", "legacy_wave_plan"] as const) {
        const prompt = industrialDocumentPrompt({ folder }, tool, locale);
        expect(prompt).toContain(tool);
        expect(prompt).toContain(JSON.stringify({ path: folder, lang: locale }));
        expect(prompt).toContain("path:line");
      }
    }
  });
});

it("uses explicit plugin overrides before template defaults and fails closed when unknown", () => {
  const templates = [{ id: "industrial", plugins: ["legacy-analyzer"] }];
  expect(industrialAnalyzerEnabled({ templateId: "industrial" }, templates)).toBe(true);
  expect(industrialAnalyzerEnabled({ templateId: "industrial", plugins: [] }, templates)).toBe(
    false,
  );
  expect(industrialAnalyzerEnabled({ templateId: null, plugins: ["legacy-analyzer"] })).toBe(true);
  expect(industrialAnalyzerEnabled({ templateId: "industrial" })).toBe(false);
});
