import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { stripProjectContext } from "../gateway/chat-sanitize.js";
import { projectsHandlers } from "../gateway/server-methods/projects.js";
import { DEPARTMENT_IDS } from "../workitems/types.js";
import { resolveDepartmentChat } from "./department-chat.js";
import {
  departmentIdOfProjectChat,
  parseProjectSessionKey,
  projectContextForAgent,
} from "./scope.js";
import { createProject, updateProject } from "./store.js";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
}));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "department-chat-"));
const previousHome = process.env.KOLO_HOME;
process.env.KOLO_HOME = path.join(root, "home");
afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = previousHome;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(agents: string[] = ["main"]) {
  const folder = fs.mkdtempSync(path.join(root, "project-"));
  fs.mkdirSync(path.join(folder, "context"));
  const project = createProject(
    { name: "Company", folder, allowedAgents: agents },
    { createdBy: "owner" },
  );
  const policy = (queues: unknown[]) =>
    fs.writeFileSync(
      path.join(folder, "context/workqueue.json"),
      JSON.stringify({ version: 1, queues, rules: [] }),
    );
  policy([{ id: "finance-work", department: "finance", types: ["request"], defaultAgent: "main" }]);
  return { project, policy };
}
async function key(params: Record<string, unknown>) {
  const respond = vi.fn();
  await projectsHandlers["projects.chatKey"]({
    params,
    respond,
  } as unknown as GatewayRequestHandlerOptions);
  return respond.mock.calls[0];
}
describe("department project conversations", () => {
  it("creates a scoped key via the gateway and supplies removable context for every project mode", async () => {
    const { project } = fixture();
    const [ok, payload] = await key({ id: project.id, departmentId: "finance" });
    expect(ok).toBe(true);
    const ref = parseProjectSessionKey((payload as { sessionKey: string }).sessionKey)!;
    expect(ref.projectId).toBe(project.id);
    expect(ref.agentId).toBe("main");
    expect(ref.chatId.length).toBeLessThanOrEqual(32);
    expect(departmentIdOfProjectChat(ref.chatId)).toBe("finance");
    for (const mode of ["read", "plan", "act"] as const) {
      const scoped = { ...project, mode };
      const resolved = resolveDepartmentChat(scoped, "finance", "main");
      const context = projectContextForAgent(scoped, "", resolved.context);
      expect(context).toContain("Department: finance");
      expect(context).toContain("Mode:");
      expect(stripProjectContext(`${context}\n\nHello`)).toBe("Hello");
    }
  });
  it("rejects unknown departments, missing configuration, missing and archived projects", async () => {
    const { project } = fixture();
    for (const departmentId of ["fake", "hr", null, 4]) {
      expect((await key({ id: project.id, departmentId }))[0]).toBe(false);
    }
    expect((await key({ id: "pmissing0000", departmentId: "finance" }))[0]).toBe(false);
    updateProject(project.id, { archived: true });
    expect((await key({ id: project.id, departmentId: "finance" }))[0]).toBe(false);
  });
  it("uses a configured allowed agent and rejects conflicts and changed routing", async () => {
    const { project, policy } = fixture(["main", "finance-agent"]);
    const queue = {
      id: "finance-work",
      department: "finance",
      types: ["request"],
      defaultAgent: "finance-agent",
    };
    policy([queue]);
    const result = await key({ id: project.id, departmentId: "finance" });
    expect(result[0]).toBe(true);
    expect((result[1] as { sessionKey: string }).sessionKey).toContain("agent:finance-agent:");
    expect((await key({ id: project.id, departmentId: "finance", agentId: "main" }))[0]).toBe(
      false,
    );
    expect(() => resolveDepartmentChat(project, "finance", "main", "main")).toThrow(
      "does not match",
    );
    policy([queue, { ...queue, id: "other", defaultAgent: "main" }]);
    expect(() => resolveDepartmentChat(project, "finance", "main")).toThrow("conflicting");
    policy([{ ...queue, defaultAgent: "outsider" }]);
    expect(() => resolveDepartmentChat(project, "finance", "main")).toThrow("not allowed");
    policy([]);
    expect(() => resolveDepartmentChat(project, "finance", "main", "finance-agent")).toThrow(
      "not configured",
    );
  });
  it("supports all catalogue departments and exact legacy queue mapping", async () => {
    const { project, policy } = fixture();
    policy(
      DEPARTMENT_IDS.map((department) => ({
        id: `${department}-work`,
        department,
        types: ["request"],
      })),
    );
    for (const departmentId of DEPARTMENT_IDS) {
      const [ok, payload] = await key({ id: project.id, departmentId });
      expect(ok).toBe(true);
      const ref = parseProjectSessionKey((payload as { sessionKey: string }).sessionKey)!;
      expect(departmentIdOfProjectChat(ref.chatId)).toBe(departmentId);
    }
    policy([{ id: "fin-expense", types: ["request"] }]);
    expect(
      resolveDepartmentChat(
        { ...project, templateId: "business-finance-expense-invoice" },
        "finance",
        "main",
      ).agentId,
    ).toBe("main");
    expect(() => resolveDepartmentChat(project, "finance", "main")).toThrow("not configured");
    policy([{ id: "finance-work", department: "fake", types: ["request"] }]);
    expect(() => resolveDepartmentChat(project, "finance", "main")).toThrow(
      "configuration is invalid",
    );
  });
  it("preserves ordinary keys and rejects malformed department tags", async () => {
    const { project } = fixture();
    const [, payload] = await key({ id: project.id });
    const ref = parseProjectSessionKey((payload as { sessionKey: string }).sessionKey)!;
    expect(departmentIdOfProjectChat(ref.chatId)).toBeNull();
    for (const value of [
      "deptfake0abc",
      "deptfinance0",
      "deptfinance0abc/",
      "deptfinance0" + "a".repeat(40),
    ]) {
      expect(departmentIdOfProjectChat(value)).toBeNull();
    }
  });
});
