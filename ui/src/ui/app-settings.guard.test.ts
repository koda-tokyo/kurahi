import { describe, expect, it } from "vitest";
import { guardTab } from "./app-settings";

type Host = Parameters<typeof guardTab>[0];

const host = (auth: unknown) =>
  ({ hello: auth === undefined ? null : { auth } }) as unknown as Host;

describe("route guard (role filter)", () => {
  it("lets everyone through while the role is unknown", () => {
    expect(guardTab(host(undefined), "logs")).toBe("logs");
    expect(guardTab(host(undefined), "policies")).toBe("policies");
  });

  it("sends business users from hidden pages to Home", () => {
    const business = host({ role: "operator", scopes: ["operator.read", "operator.approvals"] });
    expect(guardTab(business, "logs")).toBe("home");
    expect(guardTab(business, "audit")).toBe("home");
    expect(guardTab(business, "chat")).toBe("chat");
    expect(guardTab(business, "approvals")).toBe("approvals");
    expect(guardTab(business, "help")).toBe("help");
  });

  it("keeps every page for admins", () => {
    const admin = host({ role: "operator", scopes: ["operator.admin"] });
    expect(guardTab(admin, "debug")).toBe("debug");
  });
});
