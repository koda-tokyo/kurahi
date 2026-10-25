import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import type { BusinessHost } from "./business";
import { emptyBusiness, loadBusinessItem, resetBusiness, selectBusinessQueue } from "./business";
import { verifyBusinessEvidence } from "./business-evidence";
import { DEFAULT_PROJECTS_STATE } from "./projects";

function fixture() {
  const item = {
    id: "i1",
    projectId: "p1",
    revision: 3,
    history: [{ evidence: { bundle: "0001-create", root: "a".repeat(64) } }],
  } as NonNullable<BusinessHost["business"]["item"]>;
  const response = {
    bundles: [
      {
        bundle: "0001-create",
        root: "a".repeat(64),
        signer: "key1",
        status: "completed",
        ok: true,
        problems: [] as string[],
      },
    ],
    chainOk: true,
  };
  const request = vi.fn().mockResolvedValue(response);
  const host: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", selectedId: "i1", item },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { host, request, response };
}

describe("Business explicit evidence verification", () => {
  it("requests the selected scope only and records local check time and bundle count", async () => {
    const { host, request } = fixture();
    await verifyBusinessEvidence(host);
    expect(request.mock.calls).toEqual([["workitems.evidence", { projectId: "p1", id: "i1" }]]);
    expect(host.business.evidence).toMatchObject({
      itemId: "i1",
      revision: 3,
      status: "verified",
      bundles: 1,
    });
    expect(Number.isNaN(Date.parse(host.business.evidence!.checkedAt!))).toBe(false);
  });
  it.each(["chain", "bundle", "problems"])("shows a failed %s check", async (kind) => {
    const { host, response } = fixture();
    if (kind === "chain") {
      response.chainOk = false;
    }
    if (kind === "bundle") {
      response.bundles[0].ok = false;
    }
    if (kind === "problems") {
      response.bundles[0].problems = ["private path"];
    }
    await verifyBusinessEvidence(host);
    expect(host.business.evidence?.status).toBe("failed");
    expect(JSON.stringify(host.business.evidence)).not.toContain("private path");
  });
  it.each(["empty", "missing", "root", "signer", "duplicate", "malformed"])(
    "never verifies %s results",
    async (kind) => {
      const { host, request, response } = fixture();
      if (kind === "empty") {
        response.bundles = [];
      }
      if (kind === "missing") {
        response.bundles[0].bundle = "other";
      }
      if (kind === "root") {
        response.bundles[0].root = "changed";
      }
      if (kind === "signer") {
        response.bundles[0].signer = "";
      }
      if (kind === "duplicate") {
        response.bundles.push({ ...response.bundles[0] });
      }
      if (kind === "malformed") {
        request.mockResolvedValue({ chainOk: true });
      }
      await verifyBusinessEvidence(host);
      expect(host.business.evidence?.status).toBe("unavailable");
    },
  );
  it("does not leak transport errors and permits explicit retry", async () => {
    const { host, request, response } = fixture();
    request.mockRejectedValueOnce(new Error("private backend path"));
    await verifyBusinessEvidence(host);
    expect(host.business.evidence).toMatchObject({ status: "unavailable", checkedAt: null });
    expect(JSON.stringify(host.business.evidence)).not.toContain("private backend path");
    request.mockResolvedValue(response);
    await verifyBusinessEvidence(host);
    expect(host.business.evidence?.status).toBe("verified");
  });
  it.each(["reset", "project", "item", "client", "disconnect", "tab", "view"])(
    "discards delayed verification after %s",
    async (change) => {
      const { host, request, response } = fixture();
      let finish!: (value: typeof response) => void;
      request.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = verifyBusinessEvidence(host);
      await verifyBusinessEvidence(host);
      expect(request).toHaveBeenCalledTimes(1);
      if (change === "reset") {
        resetBusiness(host);
      }
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "item") {
        host.business.item = { ...host.business.item!, revision: 4 };
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      if (change === "tab") {
        host.tab = "chat";
      }
      if (change === "view") {
        host.projects.view = "chat";
      }
      finish(response);
      await pending;
      expect(host.business.evidence?.status).not.toBe("verified");
    },
  );
  it("clears the result on detail refresh and queue changes", async () => {
    const { host, request } = fixture();
    await verifyBusinessEvidence(host);
    request.mockResolvedValue({ item: host.business.item });
    await loadBusinessItem(host, "i1", true);
    expect(host.business.evidence).toBeNull();
    host.business.evidence = {
      itemId: "i1",
      revision: 3,
      status: "verified",
      bundles: 1,
      checkedAt: "now",
    };
    request.mockRejectedValue(new Error("offline"));
    await selectBusinessQueue(host, "other");
    expect(host.business.evidence).toBeNull();
  });
  it.each(["offline", "project", "loading", "detail", "decision"])(
    "does not request during %s",
    async (kind) => {
      const { host, request } = fixture();
      if (kind === "offline") {
        host.connected = false;
      }
      if (kind === "project") {
        host.projects.selectedId = "p2";
      }
      if (kind === "loading") {
        host.business.loading = true;
      }
      if (kind === "detail") {
        host.business.detailLoading = true;
      }
      if (kind === "decision") {
        host.business.decisionPending = true;
      }
      await verifyBusinessEvidence(host);
      expect(request).not.toHaveBeenCalled();
    },
  );
});
