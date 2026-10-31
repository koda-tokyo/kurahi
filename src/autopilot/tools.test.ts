import { describe, expect, it } from "vitest";
import { isEngineTool } from "./engine-tools.js";
import { gatherToolRefusal, readToolDef } from "./tools.js";

describe("gather read tools", () => {
  it("declares the Guardian checks as engine read tools", () => {
    for (const name of [
      "guardian_backup",
      "guardian_restore_test",
      "guardian_secrets",
      "guardian_ports",
      "guardian_integrity",
      "guardian_credentials",
      "guardian_scan",
      "guardian_exposure_subdomains",
      "guardian_exposure_dns",
      "guardian_exposure_web_secrets",
      "guardian_exposure_lookalikes",
      "guardian_exposure_breaches",
      "guardian_exposure_code",
      "guardian_exposure_people",
    ]) {
      expect(readToolDef(name)).toEqual({ name, provider: "engine" });
      expect(gatherToolRefusal(name)).toBeNull();
      expect(isEngineTool(name)).toBe(true);
    }
  });

  it("every engine read tool is an engine check", () => {
    for (const name of ["health_disk", "workitems_linked", "guardian_scan"]) {
      expect(isEngineTool(readToolDef(name)!.name)).toBe(true);
    }
  });

  it("refuses write tools and undeclared tools", () => {
    expect(gatherToolRefusal("exec")).toMatch(/write tool/);
    expect(gatherToolRefusal("guardian_quarantine_delete")).toMatch(/not a declared read tool/);
  });
});
