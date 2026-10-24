import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClientOptions } from "./gateway";
const clients = vi.hoisted(() => [] as { opts: GatewayBrowserClientOptions }[]);
vi.mock("./gateway", () => ({
  GatewayBrowserClient: class {
    start = vi.fn();
    stop = vi.fn();
    request = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === "workitems.config"
          ? { queues: [] }
          : { items: [], total: 0, counts: {}, nextCursor: null },
      );
    constructor(public opts: GatewayBrowserClientOptions) {
      clients.push(this);
    }
  },
}));
import { connectGateway, handleGatewayEvent } from "./app-gateway";
import { emptyBusiness } from "./controllers/business";
import { DEFAULT_PROJECTS_STATE } from "./controllers/projects";
import { emptyTerminal } from "./controllers/terminal";
type Host = Parameters<typeof connectGateway>[0];
function host() {
  return {
    settings: { gatewayUrl: "ws://example.invalid", token: "test" },
    password: "",
    client: null,
    terminal: emptyTerminal(),
    connected: false,
    execApprovalQueue: [],
    business: emptyBusiness(),
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
    tab: "projects",
    eventLogBuffer: [],
  } as unknown as Host & { business: ReturnType<typeof emptyBusiness> };
}
describe("Business gateway lifecycle", () => {
  it("clears private review state on disconnect and gateway replacement", () => {
    const h = host();
    connectGateway(h);
    h.business = { ...emptyBusiness(), projectId: "p1", selectedId: "private-item" };
    clients.at(-1)!.opts.onClose?.({ code: 1006, reason: "closed" });
    expect(h.business).toEqual(emptyBusiness());
    h.business.selectedId = "private-item";
    connectGateway(h);
    expect(h.business).toEqual(emptyBusiness());
  });
  it("refetches on event gaps and keeps change event payloads out of the debug log", async () => {
    const h = host();
    connectGateway(h);
    h.connected = true;
    clients.at(-1)!.opts.onGap?.({ expected: 1, received: 3 });
    await vi.waitFor(() => expect(h.business.list).not.toBeNull());
    handleGatewayEvent(h, {
      type: "event",
      event: "workitems.changed",
      payload: { projectId: "p1", title: "never trust this" },
    });
    expect(h.eventLogBuffer).toEqual([]);
  });
});
