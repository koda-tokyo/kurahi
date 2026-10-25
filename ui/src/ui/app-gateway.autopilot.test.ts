import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClientOptions } from "./gateway";

const clients = vi.hoisted(
  () => [] as { opts: GatewayBrowserClientOptions; request: ReturnType<typeof vi.fn> }[],
);
vi.mock("./gateway", () => ({
  GatewayBrowserClient: class {
    start = vi.fn();
    stop = vi.fn();
    request = vi.fn(async (method: string) => {
      if (method === "autopilot.routines.list") {
        return { routines: [], error: null, source: { kind: "none", path: null } };
      }
      if (method === "autopilot.runs.list") {
        return { runs: [], total: 0, nextCursor: null };
      }
      return { totals: {}, routines: [], areas: [] };
    });
    constructor(public opts: GatewayBrowserClientOptions) {
      clients.push(this);
    }
  },
}));
import { connectGateway, handleGatewayEvent } from "./app-gateway";
import { emptyAutopilot, loadAutopilot } from "./controllers/autopilot";
import { emptyBusiness } from "./controllers/business";
import { DEFAULT_PROJECTS_STATE } from "./controllers/projects";
import { emptyTerminal } from "./controllers/terminal";

type Host = Parameters<typeof connectGateway>[0] & Parameters<typeof loadAutopilot>[0];
function host() {
  return {
    settings: { gatewayUrl: "ws://example.invalid", token: "test" },
    password: "",
    client: null,
    terminal: emptyTerminal(),
    connected: false,
    execApprovalQueue: [],
    business: emptyBusiness(),
    autopilot: emptyAutopilot(),
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "autopilot" },
    tab: "projects",
    eventLogBuffer: [],
  } as unknown as Host;
}

describe("Autopilot gateway lifecycle", () => {
  it("clears Project state on disconnect and connection replacement", async () => {
    const h = host();
    connectGateway(h);
    h.connected = true;
    await loadAutopilot(h);
    expect(h.autopilot.projectId).toBe("p1");
    clients.at(-1)!.opts.onClose?.({ code: 1006, reason: "closed" });
    expect(h.autopilot).toEqual(emptyAutopilot());
    h.autopilot.projectId = "private-project";
    connectGateway(h);
    expect(h.autopilot).toEqual(emptyAutopilot());
  });

  it("refreshes after gaps and relevant changes without retaining event payloads", async () => {
    const h = host();
    connectGateway(h);
    h.connected = true;
    const request = clients.at(-1)!.request;
    clients.at(-1)!.opts.onGap?.({ expected: 1, received: 4 });
    await vi.waitFor(() => expect(h.autopilot.runs).not.toBeNull());
    expect(request).toHaveBeenCalledTimes(5);
    handleGatewayEvent(h, {
      type: "event",
      event: "autopilot.changed",
      payload: { projectId: "another-project", privateText: "must not persist" },
    });
    expect(request).toHaveBeenCalledTimes(5);
    handleGatewayEvent(h, {
      type: "event",
      event: "autopilot.changed",
      payload: { projectId: "p1", privateText: "must not persist" },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(10));
    expect(h.eventLogBuffer).toEqual([]);
    expect(JSON.stringify(h.autopilot)).not.toContain("must not persist");
  });
});
