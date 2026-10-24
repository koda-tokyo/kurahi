import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function industrial(mode: "plan" | "act") {
  const harness = createHarness({ mode });
  fs.mkdirSync(path.join(harness.folder, "source"));
  fs.mkdirSync(path.join(harness.folder, "output"));
  fs.writeFileSync(path.join(harness.folder, "source", "PAY.cbl"), "MOVE A TO B.\n");
  harness.project.rules = {
    ...harness.project.rules,
    readOnly: ["source", "data", "docs"],
    writable: ["output"],
  };
  return harness;
}

describe("terminal broker: read-only folders", () => {
  for (const mode of ["plan", "act"] as const) {
    it(`refuses a write into a read-only folder in ${mode} mode, without offering approval`, async () => {
      h = industrial(mode);
      const { sessionId } = await h.open();
      h.broker.input(sessionId, "owner", "touch source/x\r");
      await vi.waitFor(() => expect(h?.notices()).toContain("read-only-path"));
      expect(h.approvals.requests).toHaveLength(0);
      expect(h.ofType("approval.requested")).toHaveLength(0);
      expect(h.backend.spawns).toHaveLength(0);
      expect(h.ofType("notice").find((e) => e.code === "read-only-path")).toMatchObject({
        params: { folder: "source" },
      });
      expect(h.audits).toContainEqual(
        expect.objectContaining({
          action: "terminal.command",
          outcome: "denied",
          detail: expect.objectContaining({
            code: "read-only-path",
            risks: expect.arrayContaining(["read-only-path"]),
          }),
        }),
      );
    });
  }

  it("still runs reads of a read-only folder", async () => {
    h = industrial("plan");
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "cat source/PAY.cbl\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    expect(h.approvals.requests).toHaveLength(0);
    expect(h.notices()).not.toContain("read-only-path");
  });

  it("unlocks a folder when the project config no longer lists it", async () => {
    h = industrial("plan");
    const { sessionId } = await h.open();
    h.project.rules = { ...h.project.rules, readOnly: ["data", "docs"] };
    h.broker.input(sessionId, "owner", "touch source/x\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    expect(h.notices()).not.toContain("read-only-path");
  });

  it("refuses after approval when a folder became read-only while waiting", async () => {
    h = industrial("plan");
    h.project.rules = { ...h.project.rules, readOnly: [] };
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "touch source/x\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.project.rules = { ...h.project.rules, readOnly: ["source"] };
    h.approvals.resolve(h.ofType("approval.requested")[0].approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.notices()).toContain("read-only-path"));
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("reports a write that slipped through (a script) as a policy violation", async () => {
    h = industrial("act");
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "./tools/convert.sh\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.approvals.resolve(h.ofType("approval.requested")[0].approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    // The script writes into source/ and output/.
    fs.writeFileSync(path.join(h.folder, "source", "PAY.cbl"), "MOVE B TO A.\n");
    fs.writeFileSync(path.join(h.folder, "output", "PAY.java"), "class Pay {}\n");
    h.backend.spawns[0].exit(0);
    await vi.waitFor(() => expect(h?.ofType("file.diff")).toHaveLength(1));
    const diff = h.ofType("file.diff")[0];
    expect(diff.violations).toBe(1);
    expect(diff.files[0]).toMatchObject({
      path: "source/PAY.cbl",
      status: "modified",
      violation: "read-only-path",
    });
    expect(diff.files.find((f) => f.path === "output/PAY.java")?.violation).toBeUndefined();
    expect(h.ofType("notice").find((e) => e.code === "read-only-violation")).toMatchObject({
      runId: diff.runId,
      params: { files: 1, folder: "source" },
    });
    expect(h.audits).toContainEqual(
      expect.objectContaining({
        action: "terminal.violation",
        outcome: "denied",
        detail: expect.objectContaining({
          code: "read-only-path",
          runId: diff.runId,
          folders: ["source"],
          paths: ["modified:source/PAY.cbl"],
        }),
      }),
    );
    expect(h.audits).toContainEqual(
      expect.objectContaining({
        action: "terminal.exit",
        detail: expect.objectContaining({ diff: expect.objectContaining({ violations: 1 }) }),
      }),
    );
    const page = h.broker.diff(diff.diffId, "owner");
    expect(page.files[0]).toMatchObject({ path: "source/PAY.cbl", violation: "read-only-path" });
  });

  it("a diff without read-only changes carries no violations", async () => {
    h = industrial("act");
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "touch output/x\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.approvals.resolve(h.ofType("approval.requested")[0].approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    fs.writeFileSync(path.join(h.folder, "output", "x"), "");
    h.backend.spawns[0].exit(0);
    await vi.waitFor(() => expect(h?.ofType("file.diff")).toHaveLength(1));
    expect(h.ofType("file.diff")[0].violations).toBeUndefined();
    expect(h.notices()).not.toContain("read-only-violation");
  });
});
