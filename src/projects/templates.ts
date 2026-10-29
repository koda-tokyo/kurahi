// Project templates and terminal profiles are data: JSON files in `templates/projects/` of the
// Kurahi package (or `KURAHI_PROJECT_TEMPLATES_DIR`). Adding a template is adding a file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalizedText, ProjectTemplate, TerminalProfile } from "./types.js";
import { cleanRelPath, cleanRules } from "./store.js";

export const TEMPLATES_DIR_ENV = "KURAHI_PROJECT_TEMPLATES_DIR";
const PROFILES_FILE = "terminal-profiles.json";

/** `templates/projects` next to the package root (dist/projects/… or src/projects/…). */
export function resolveTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TEMPLATES_DIR_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "templates", "projects");
}

function text(raw: unknown): LocalizedText {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    ...(typeof r.ja === "string" ? { ja: r.ja } : {}),
    ...(typeof r.en === "string" ? { en: r.en } : {}),
  };
}

function texts(raw: unknown): LocalizedText[] {
  return Array.isArray(raw) ? raw.map(text).filter((t) => t.ja || t.en) : [];
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type TemplateWithDemo = ProjectTemplate & { demoFolder?: string };

export function parseTemplate(raw: unknown): TemplateWithDemo | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(r.id)) {
    return null;
  }
  const demo = typeof r.demoFolder === "string" ? r.demoFolder : undefined;
  return {
    id: r.id,
    name: text(r.name),
    description: text(r.description),
    folders: strings(r.folders)
      .map(cleanRelPath)
      .filter((p): p is string => p !== null && p !== "."),
    rules: cleanRules(r.rules),
    suggestedAgents: strings(r.suggestedAgents),
    suggestedSkills: strings(r.suggestedSkills),
    plugins: strings(r.plugins).filter((id) => PLUGIN_ID_RE.test(id)),
    // Fill-in forms and starter data (e.g. a sample price list) copied into a new project's
    // read-only folders (pack.ts seedStarterFiles).
    starterFiles: strings(r.starterFiles)
      .map(cleanRelPath)
      .filter((p): p is string => p !== null && p !== "." && /\.(md|txt|csv|json)$/i.test(p))
      .slice(0, 10),
    starterPrompts: texts(r.starterPrompts),
    terminalProfile: typeof r.terminalProfile === "string" ? r.terminalProfile : "standard",
    ...(demo ? { demoFolder: demo.replace(/^~(?=$|\/)/, os.homedir()) } : {}),
  };
}

export function loadTemplates(dir: string = resolveTemplatesDir()): TemplateWithDemo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== PROFILES_FILE);
  } catch {
    return [];
  }
  const out: TemplateWithDemo[] = [];
  for (const name of names.toSorted()) {
    try {
      const t = parseTemplate(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      if (t) {
        out.push(t);
      }
    } catch {
      // skip unreadable template files
    }
  }
  return out;
}

export function loadTerminalProfiles(dir: string = resolveTemplatesDir()): TerminalProfile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, PROFILES_FILE), "utf8")) as {
      profiles?: unknown[];
    };
    return (raw.profiles ?? [])
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .filter((p) => typeof p.id === "string")
      .map((p) => ({
        id: String(p.id),
        label: text(p.label),
        allowedCommandsPolicy: text(p.allowedCommandsPolicy),
        enabledByDefault: p.enabledByDefault === true,
        clientIsolated: p.clientIsolated === true,
        justInTime: p.justInTime === true,
      }));
  } catch {
    return [];
  }
}
