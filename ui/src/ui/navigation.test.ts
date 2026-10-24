import { describe, expect, it } from "vitest";
import { en } from "./i18n/en";
import { ja } from "./i18n/ja";
import {
  ALL_TABS,
  BUSINESS_PAGES,
  LEGACY_PATHS,
  NAV_GROUPS,
  PAGES,
  audienceFromAuth,
  iconForPage,
  iconForTab,
  inferBasePathFromPathname,
  isLegacyPath,
  isTabVisible,
  normalizeBasePath,
  normalizePath,
  pageForTab,
  pathForPage,
  pathForTab,
  subtitleKeyForPage,
  tabFromPath,
  tabLabelKey,
  tabsForPage,
  titleKeyForPage,
  visiblePages,
  type Page,
  type Tab,
} from "./navigation";

const ALL_PAGES = NAV_GROUPS.flatMap((g) => g.pages);

describe("sidebar structure", () => {
  it("has the v0.2 groups in order", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(["top", "work", "governance", "system", "bottom"]);
    expect(NAV_GROUPS.map((g) => g.pages)).toEqual([
      ["home", "chat", "projects", "approvals"],
      ["agents", "artifacts", "automations", "skills", "connections"],
      ["policies", "audit", "evaluation"],
      ["devices", "models", "settings"],
      ["help"],
    ]);
  });

  it("lists every page once and every tab under exactly one page", () => {
    expect(new Set(ALL_PAGES).size).toBe(ALL_PAGES.length);
    expect(new Set(ALL_PAGES)).toEqual(new Set(Object.keys(PAGES)));
    const tabs = Object.values(PAGES).flatMap((p) => p.tabs);
    expect(new Set(tabs).size).toBe(tabs.length);
    expect(new Set(ALL_TABS)).toEqual(new Set(tabs));
  });

  it("groups existing views as sub-tabs", () => {
    expect(tabsForPage("agents")).toEqual(["fleet", "sessions"]);
    expect(tabsForPage("automations")).toEqual(["cron"]);
    expect(tabsForPage("connections")).toEqual(["channels", "connectors"]);
    expect(tabsForPage("devices")).toEqual(["instances", "nodes"]);
    expect(tabsForPage("settings")).toEqual(["config", "overview", "logs", "debug"]);
    expect(pageForTab("logs")).toBe("settings");
    expect(pageForTab("cron")).toBe("automations");
  });

  it("has an icon for every page and tab", () => {
    for (const page of ALL_PAGES) {
      expect(iconForPage(page)).toBeTruthy();
    }
    for (const tab of ALL_TABS) {
      expect(iconForTab(tab)).toBe(iconForPage(pageForTab(tab)));
    }
    expect(iconForTab("unknown" as Tab)).toBe("home");
  });

  it("has Japanese and English labels for every page and sub-tab", () => {
    for (const page of ALL_PAGES) {
      for (const key of [titleKeyForPage(page), subtitleKeyForPage(page)]) {
        expect(en[key], key).toBeTruthy();
        expect(ja[key], key).toBeTruthy();
      }
    }
    for (const page of ALL_PAGES) {
      if (tabsForPage(page).length > 1) {
        for (const tab of tabsForPage(page)) {
          expect(en[tabLabelKey(tab)], tab).toBeTruthy();
          expect(ja[tabLabelKey(tab)], tab).toBeTruthy();
        }
      }
    }
    for (const group of NAV_GROUPS) {
      if (group.label) {
        expect(ja[group.label]).toBeTruthy();
      }
    }
    expect(ja["page.automations"]).toBe("自動化");
    expect(ja["page.connections"]).toBe("連携");
    expect(ja["page.artifacts"]).toBe("成果物");
    expect(ja["leaf.connectors"]).toBe("データ連携");
  });
});

describe("paths", () => {
  it("gives each page a path and nested paths for sub-tabs", () => {
    expect(pathForTab("home")).toBe("/home");
    expect(pathForTab("cron")).toBe("/automations");
    expect(pathForTab("channels")).toBe("/connections");
    expect(pathForTab("connectors")).toBe("/connections/connectors");
    expect(pathForTab("fleet")).toBe("/agents");
    expect(pathForTab("sessions")).toBe("/agents/sessions");
    expect(pathForTab("instances")).toBe("/devices");
    expect(pathForTab("nodes")).toBe("/devices/nodes");
    expect(pathForTab("config")).toBe("/settings");
    expect(pathForTab("overview")).toBe("/settings/connection");
    expect(pathForTab("logs")).toBe("/settings/logs");
    expect(pathForTab("debug")).toBe("/settings/debug");
    expect(pathForPage("audit")).toBe("/audit");
  });

  it("round-trips every tab", () => {
    for (const tab of ALL_TABS) {
      expect(tabFromPath(pathForTab(tab))).toBe(tab);
      expect(tabFromPath(pathForTab(tab, "/ui"), "/ui")).toBe(tab);
      expect(isLegacyPath(pathForTab(tab))).toBe(false);
    }
  });

  it("prepends base paths", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/KoLo")).toBe("/apps/KoLo/agents/sessions");
  });

  it("opens Home at the root and at an entry page", () => {
    expect(tabFromPath("/")).toBe("home");
    expect(tabFromPath("/index.html")).toBe("home");
    expect(tabFromPath("/control.html")).toBe("home");
    expect(tabFromPath("/ui", "/ui")).toBe("home");
  });

  it("returns null for unknown paths and is case-insensitive", () => {
    expect(tabFromPath("/unknown")).toBeNull();
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Automations")).toBe("cron");
  });
});

describe("old URLs redirect", () => {
  const expected: Record<string, { tab: Tab; to: string }> = {
    "/overview": { tab: "home", to: "/home" },
    "/fleet": { tab: "fleet", to: "/agents" },
    "/sessions": { tab: "sessions", to: "/agents/sessions" },
    "/cron": { tab: "cron", to: "/automations" },
    "/schedules": { tab: "cron", to: "/automations" },
    "/channels": { tab: "channels", to: "/connections" },
    "/instances": { tab: "instances", to: "/devices" },
    "/nodes": { tab: "nodes", to: "/devices/nodes" },
    "/config": { tab: "config", to: "/settings" },
    "/debug": { tab: "debug", to: "/settings/debug" },
    "/logs": { tab: "logs", to: "/settings/logs" },
  };

  it("maps every old path to its tab and new path", () => {
    expect(Object.keys(LEGACY_PATHS).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [old, { tab, to }] of Object.entries(expected)) {
      expect(tabFromPath(old), old).toBe(tab);
      expect(isLegacyPath(old), old).toBe(true);
      expect(pathForTab(tabFromPath(old) as Tab)).toBe(to);
    }
  });

  it("redirects under a base path too", () => {
    expect(tabFromPath("/ui/cron", "/ui")).toBe("cron");
    expect(isLegacyPath("/ui/cron", "/ui")).toBe(true);
    expect(pathForTab("cron", "/ui")).toBe("/ui/automations");
    expect(isLegacyPath("/ui/automations", "/ui")).toBe(false);
  });
});

describe("normalizeBasePath / normalizePath", () => {
  it("normalizes base paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("ui")).toBe("/ui");
    expect(normalizeBasePath("/ui/")).toBe("/ui");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("/apps/KoLo")).toBe("/apps/KoLo");
  });

  it("normalizes paths", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("chat")).toBe("/chat");
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("inferBasePathFromPathname", () => {
  it("finds the base for new, nested and old paths", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/KoLo/agents/sessions")).toBe("/apps/KoLo");
    expect(inferBasePathFromPathname("/apps/KoLo/cron")).toBe("/apps/KoLo");
    expect(inferBasePathFromPathname("/ui/overview")).toBe("/ui");
  });

  it("treats an entry page as the root", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
    expect(inferBasePathFromPathname("/control.html")).toBe("");
  });
});

describe("role filter", () => {
  it("derives the audience from the connect-time auth", () => {
    expect(audienceFromAuth(null)).toBeNull();
    expect(audienceFromAuth(undefined)).toBeNull();
    expect(audienceFromAuth({})).toBeNull();
    expect(
      audienceFromAuth({ role: "operator", scopes: ["operator.admin", "operator.approvals"] }),
    ).toBe("admin");
    expect(
      audienceFromAuth({ role: "operator", scopes: ["operator.read", "operator.approvals"] }),
    ).toBe("business");
    expect(audienceFromAuth({ role: "operator" })).toBe("business");
  });

  it("shows everything when the role is unknown or admin", () => {
    expect(visiblePages(null)).toEqual(ALL_PAGES);
    expect(visiblePages("admin")).toEqual(ALL_PAGES);
  });

  it("shows business users only Home, Chat, Projects, Approvals and Help", () => {
    expect(visiblePages("business")).toEqual(["home", "chat", "projects", "approvals", "help"]);
    expect(BUSINESS_PAGES).toEqual(["home", "chat", "projects", "approvals", "help"]);
    const hidden: Page[] = ["agents", "policies", "audit", "settings", "models", "devices"];
    for (const page of hidden) {
      expect(visiblePages("business")).not.toContain(page);
    }
    expect(isTabVisible("chat", "business")).toBe(true);
    expect(isTabVisible("logs", "business")).toBe(false);
    expect(isTabVisible("logs", null)).toBe(true);
  });
});
