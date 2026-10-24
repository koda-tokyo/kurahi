// Control UI navigation (v0.2 enterprise sidebar).
//
// A *page* is one sidebar entry. A *tab* is one view inside a page; pages with several views
// (Agents, Connections, Devices, Settings) show them as sub-tabs. `state.tab` is always a tab, so
// every loader keyed on the tab keeps working. Old URLs (/overview, /fleet, /cron, /instances,
// /nodes, /debug, /logs, /channels, /sessions, /config, /schedules) resolve to their new tab and
// the app rewrites the address bar to the new path.
import type { MessageId } from "./i18n";
import type { IconName } from "./icons.js";

export type Tab =
  | "home"
  | "chat"
  | "projects"
  | "approvals"
  | "fleet"
  | "sessions"
  | "artifacts"
  | "cron"
  | "skills"
  | "channels"
  | "connectors"
  | "policies"
  | "audit"
  | "evaluation"
  | "instances"
  | "nodes"
  | "models"
  | "config"
  | "overview"
  | "logs"
  | "debug"
  | "help";

export type Page =
  | "home"
  | "chat"
  | "projects"
  | "approvals"
  | "agents"
  | "artifacts"
  | "automations"
  | "skills"
  | "connections"
  | "policies"
  | "audit"
  | "evaluation"
  | "devices"
  | "models"
  | "settings"
  | "help";

type PageDef = { path: string; tabs: readonly Tab[]; icon: IconName };

/** Each page, its path and its tabs (the first tab is the page's default view). */
export const PAGES: Record<Page, PageDef> = {
  home: { path: "/home", tabs: ["home"], icon: "home" },
  chat: { path: "/chat", tabs: ["chat"], icon: "messageSquare" },
  projects: { path: "/projects", tabs: ["projects"], icon: "folder" },
  approvals: { path: "/approvals", tabs: ["approvals"], icon: "shieldCheck" },
  agents: { path: "/agents", tabs: ["fleet", "sessions"], icon: "users" },
  artifacts: { path: "/artifacts", tabs: ["artifacts"], icon: "package" },
  automations: { path: "/automations", tabs: ["cron"], icon: "repeat" },
  skills: { path: "/skills", tabs: ["skills"], icon: "zap" },
  connections: { path: "/connections", tabs: ["channels", "connectors"], icon: "link" },
  policies: { path: "/policies", tabs: ["policies"], icon: "shield" },
  audit: { path: "/audit", tabs: ["audit"], icon: "clipboardList" },
  evaluation: { path: "/evaluation", tabs: ["evaluation"], icon: "gauge" },
  devices: { path: "/devices", tabs: ["instances", "nodes"], icon: "monitor" },
  models: { path: "/models", tabs: ["models"], icon: "cpu" },
  settings: { path: "/settings", tabs: ["config", "overview", "logs", "debug"], icon: "settings" },
  help: { path: "/help", tabs: ["help"], icon: "helpCircle" },
};

export type NavGroup = {
  id: "top" | "work" | "governance" | "system" | "bottom";
  label: MessageId | null;
  pages: readonly Page[];
};

/** Sidebar order. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "top", label: null, pages: ["home", "chat", "projects", "approvals"] },
  {
    id: "work",
    label: "nav.group.work",
    pages: ["agents", "artifacts", "automations", "skills", "connections"],
  },
  { id: "governance", label: "nav.group.governance", pages: ["policies", "audit", "evaluation"] },
  { id: "system", label: "nav.group.system", pages: ["devices", "models", "settings"] },
  { id: "bottom", label: null, pages: ["help"] },
];

/** Sub-paths for a page's non-default tabs. */
const TAB_SLUGS: Partial<Record<Tab, string>> = {
  sessions: "sessions",
  connectors: "connectors",
  nodes: "nodes",
  overview: "connection",
  logs: "logs",
  debug: "debug",
};

const PAGE_OF_TAB = new Map<Tab, Page>();
for (const [page, def] of Object.entries(PAGES) as [Page, PageDef][]) {
  for (const tab of def.tabs) {
    PAGE_OF_TAB.set(tab, page);
  }
}

export const ALL_TABS: readonly Tab[] = [...PAGE_OF_TAB.keys()];

function canonicalPath(tab: Tab): string {
  const page = pageForTab(tab);
  const def = PAGES[page];
  if (def.tabs[0] === tab) {
    return def.path;
  }
  return `${def.path}/${TAB_SLUGS[tab] ?? tab}`;
}

/** Paths from before v0.2, and aliases, that redirect to a tab's canonical path. */
export const LEGACY_PATHS: Readonly<Record<string, Tab>> = {
  "/overview": "home",
  "/fleet": "fleet",
  "/sessions": "sessions",
  "/cron": "cron",
  "/schedules": "cron",
  "/channels": "channels",
  "/instances": "instances",
  "/nodes": "nodes",
  "/config": "config",
  "/debug": "debug",
  "/logs": "logs",
};

const PATH_TO_TAB = new Map<string, Tab>();
for (const tab of ALL_TABS) {
  PATH_TO_TAB.set(canonicalPath(tab), tab);
}
for (const [path, tab] of Object.entries(LEGACY_PATHS)) {
  if (!PATH_TO_TAB.has(path)) {
    PATH_TO_TAB.set(path, tab);
  }
}

export function pageForTab(tab: Tab): Page {
  return PAGE_OF_TAB.get(tab) ?? "home";
}

export function tabsForPage(page: Page): readonly Tab[] {
  return PAGES[page].tabs;
}

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** `/index.html` and a desktop entry page such as `/control.html` mean the app root. */
function stripHtmlEntry(path: string): string {
  return path.replace(/\/[a-z0-9_-]+\.html$/i, "") || "/";
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = canonicalPath(tab);
  return base ? `${base}${path}` : path;
}

export function pathForPage(page: Page, basePath = ""): string {
  return pathForTab(PAGES[page].tabs[0], basePath);
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  const normalized = normalizePath(stripHtmlEntry(normalizePath(path))).toLowerCase();
  if (normalized === "/") {
    return "home";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

/** True when `pathname` is an old or alias path that the app should rewrite. */
export function isLegacyPath(pathname: string, basePath = ""): boolean {
  const tab = tabFromPath(pathname, basePath);
  if (!tab) {
    return false;
  }
  const base = normalizeBasePath(basePath);
  const rel = base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  return normalizePath(rel).toLowerCase() !== canonicalPath(tab);
}

export function inferBasePathFromPathname(pathname: string): string {
  const normalized = normalizePath(stripHtmlEntry(normalizePath(pathname)));
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

// ---- audience (role-based sidebar) ----

/** Who is using the UI. `null`: the UI does not know, so everything is shown. */
export type Audience = "admin" | "business" | null;

/** Pages a business user sees (projects: to work in them; creating them stays admin-only). */
export const BUSINESS_PAGES: readonly Page[] = ["home", "chat", "projects", "approvals", "help"];

/**
 * Derive the audience from what the gateway told us at connect time. The shared gateway token
 * and paired operator devices carry `operator.admin`; a credential without it is a business user.
 * No auth info at all (older gateway, not connected): unknown.
 */
export function audienceFromAuth(
  auth: { role?: string; scopes?: string[] } | null | undefined,
): Audience {
  if (!auth || (!auth.role && !Array.isArray(auth.scopes))) {
    return null;
  }
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  if (scopes.includes("operator.admin")) {
    return "admin";
  }
  return "business";
}

/** The single role filter for the sidebar and routing. */
export function visiblePages(audience: Audience): Page[] {
  const all = NAV_GROUPS.flatMap((g) => g.pages);
  if (audience === "business") {
    return all.filter((p) => BUSINESS_PAGES.includes(p));
  }
  return all;
}

export function isTabVisible(tab: Tab, audience: Audience): boolean {
  return visiblePages(audience).includes(pageForTab(tab));
}

// ---- labels ----

export function iconForTab(tab: Tab): IconName {
  return PAGES[pageForTab(tab)]?.icon ?? "folder";
}

export function iconForPage(page: Page): IconName {
  return PAGES[page]?.icon ?? "folder";
}

export function titleKeyForPage(page: Page): MessageId {
  return `page.${page}` as MessageId;
}

export function subtitleKeyForPage(page: Page): MessageId {
  return `sub.${page}` as MessageId;
}

/** Label of a sub-tab (only pages with several tabs show them). */
export function tabLabelKey(tab: Tab): MessageId {
  return `leaf.${tab}` as MessageId;
}
