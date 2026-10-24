import { describe, expect, it } from "vitest";
import {
  capabilityPacksForEdition,
  getEditionManifest,
  getWorkspaceManifest,
  isEditionId,
  isWorkspaceId,
  resolveWorkspaceId,
  workspacesForEdition,
  WORKSPACE_IDS,
  type EditionId,
  type WorkspaceId,
} from "./manifests.js";

describe("edition and workspace manifests", () => {
  it.each(WORKSPACE_IDS)("references shipped project templates for %s", (workspaceId) => {
    const catalog = import.meta.glob<{ id: string }>(
      [
        "../../../../templates/projects/*.json",
        "!../../../../templates/projects/terminal-profiles.json",
      ],
      { eager: true, import: "default" },
    );
    const shippedIds = Object.values(catalog).map((template) => template.id);
    const references = getWorkspaceManifest(workspaceId).projectTemplates;

    expect(references.length).toBeGreaterThan(0);
    expect(new Set(references).size).toBe(references.length);
    for (const id of references) {
      expect(shippedIds, `${workspaceId} references missing template ${id}`).toContain(id);
    }
  });

  it("maps each licensed edition to its base workspace set", () => {
    const mappings: Readonly<Record<EditionId, readonly WorkspaceId[]>> = {
      industrial: ["industrial"],
      business: ["backoffice"],
      scholars: ["research", "education"],
      core: ["generic"],
    };

    for (const editionId of Object.keys(mappings) as EditionId[]) {
      const manifest = getEditionManifest(editionId);
      expect(manifest.allowedBaseWorkspaces).toEqual(mappings[editionId]);
      expect(manifest.allowedBaseWorkspaces).toContain(manifest.defaultWorkspace);
      expect(manifest.licence.edition).toBe(editionId);
      expect(workspacesForEdition(editionId)).toEqual(mappings[editionId]);
    }
  });

  it("validates persisted edition and workspace identifiers", () => {
    expect(isEditionId("industrial")).toBe(true);
    expect(isEditionId("enterprise")).toBe(false);
    expect(isWorkspaceId("backoffice")).toBe(true);
    expect(isWorkspaceId("factory")).toBe(false);
  });

  it("resolves only licensed or pack-enabled workspaces and falls back to default", () => {
    expect(resolveWorkspaceId("business", "backoffice")).toBe("backoffice");
    expect(resolveWorkspaceId("business", "research")).toBe("backoffice");
    expect(resolveWorkspaceId("industrial", "education")).toBe("industrial");
    expect(resolveWorkspaceId("core", "not-a-workspace")).toBe("generic");
    expect(resolveWorkspaceId("scholars", null)).toBe("research");
    expect(resolveWorkspaceId("industrial", "research", ["analysis"])).toBe("industrial");
  });

  it("keeps Scholars Research and Education roles and navigation distinct", () => {
    const research = getWorkspaceManifest("research");
    const education = getWorkspaceManifest("education");

    expect(research.defaultAgentRoles).toContain("statistical-reviewer");
    expect(research.defaultAgentRoles).toContain("reproducibility-agent");
    expect(research.navigation.map((item) => item.id)).toContain("experiments");
    expect(education.defaultAgentRoles).toContain("tutor");
    expect(education.defaultAgentRoles).toContain("safeguarding-checker");
    expect(education.navigation.map((item) => item.id)).toContain("assignments");
    expect(education.density).toBe("comfortable");
    expect(research.defaultAgentRoles).not.toEqual(education.defaultAgentRoles);
  });

  it("models industrial lanes as capability packs without creating more editions", () => {
    const industrialBase = getEditionManifest("industrial").allowedBaseWorkspaces;
    const businessBase = getEditionManifest("business").allowedBaseWorkspaces;
    const packs = capabilityPacksForEdition("industrial");

    expect(packs.map((pack) => pack.id)).toEqual([
      "analysis",
      "modernisation",
      "controls",
      "maintenance",
      "cybersecurity",
    ]);
    expect(packs.map((pack) => pack.readiness)).toEqual([
      "active",
      "unverified",
      "disabled",
      "unverified",
      "planned",
    ]);
    expect(packs.every((pack) => pack.availableTo.includes("industrial"))).toBe(true);
    expect(capabilityPacksForEdition("business")).toEqual([]);
    expect(workspacesForEdition("industrial", ["analysis", "maintenance"])).toEqual(["industrial"]);
    expect(getEditionManifest("industrial").allowedBaseWorkspaces).toBe(industrialBase);
    expect(getEditionManifest("business").allowedBaseWorkspaces).toBe(businessBase);
    expect(industrialBase).toEqual(["industrial"]);
    expect(businessBase).toEqual(["backoffice"]);
  });
});
