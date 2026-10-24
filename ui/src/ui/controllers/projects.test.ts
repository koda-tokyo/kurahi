import { describe, expect, it, vi } from "vitest";
import { loadProjects, sortProjectsByRecent, visibleProjects, type Project } from "./projects";

const project = (id: string, updatedAt: string, archived = false): Project =>
  ({ id, updatedAt, archived }) as Project;

describe("project list", () => {
  it("hides archived projects by default and includes them on request", () => {
    const projects = [
      project("old", "2026-10-01T00:00:00Z"),
      project("archived", "2026-10-03T00:00:00Z", true),
    ];

    expect(visibleProjects(projects, false).map((item) => item.id)).toEqual(["old"]);
    expect(visibleProjects(projects, true).map((item) => item.id)).toEqual(["archived", "old"]);
  });

  it("sorts most recently updated projects first and keeps stable ties", () => {
    const projects = [
      project("first-tie", "2026-10-02T00:00:00Z"),
      project("recent", "2026-10-03T00:00:00Z"),
      project("second-tie", "2026-10-02T00:00:00Z"),
      project("unknown", "invalid"),
    ];

    expect(sortProjectsByRecent(projects).map((item) => item.id)).toEqual([
      "recent",
      "first-tie",
      "second-tie",
      "unknown",
    ]);
  });

  it("requests archived projects only when the preference is enabled", async () => {
    const request = vi.fn((method: string) => {
      if (method === "projects.list") {
        return Promise.resolve({ projects: [project("visible", "2026-10-03T00:00:00Z")] });
      }
      return Promise.resolve({ templates: [], terminalProfiles: [] });
    });
    const host = {
      client: { request },
      connected: true,
      projects: { projects: [], selectedId: null, showArchived: true },
    } as unknown as Parameters<typeof loadProjects>[0];

    await loadProjects(host);

    expect(request).toHaveBeenCalledWith("projects.list", { includeArchived: true });
    expect(host.projects.projects.map((item) => item.id)).toEqual(["visible"]);
  });

  it("keeps project results when templates fail and reports the partial failure", async () => {
    const request = vi.fn((method: string) =>
      method === "projects.list"
        ? Promise.resolve({ projects: [project("visible", "2026-10-03T00:00:00Z")] })
        : Promise.reject(new Error("templates unavailable")),
    );
    const host = {
      client: { request },
      connected: true,
      projects: { projects: [], selectedId: null, showArchived: false },
    } as unknown as Parameters<typeof loadProjects>[0];

    await loadProjects(host);

    expect(host.projects.projects.map((item) => item.id)).toEqual(["visible"]);
    expect(host.projects.error).toContain("templates unavailable");
  });
});
