// The WhatsApp Web library (Baileys) is not a dependency of the Kurahi runtime: it pulls in
// libsignal (GPL-3.0), so it ships only with the separately installed WhatsApp plugin
// (`kurahi plugins install <kurahi-whatsapp tarball>`, which runs `npm install` in the plugin
// folder). Every WhatsApp module gets the library from here instead of importing it directly, so
// the runtime starts, and every other channel works, when it is absent.
//
// Resolution order: next to the runtime (development checkouts, or an operator who installed it
// beside Kurahi), then inside the installed plugin's own node_modules.
import type * as BaileysNamespace from "@whiskeysockets/baileys";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR } from "../utils.js";

export type Baileys = typeof BaileysNamespace;

const PACKAGE = "@whiskeysockets/baileys";

export class WhatsAppRuntimeMissingError extends Error {
  constructor() {
    super(
      "WhatsApp is not installed. It is an optional plugin with a GPL-3.0 dependency and is not " +
        "part of the default Kurahi package: install it with `kurahi plugins install " +
        "<kurahi-whatsapp-<version>.tgz>` (see docs/channels/whatsapp.md), then restart the gateway.",
    );
    this.name = "WhatsAppRuntimeMissingError";
  }
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Entry file of the library inside an installed plugin folder, if present. */
export function pluginBaileysEntry(extensionsDir: string): string | null {
  const pkgDir = path.join(extensionsDir, "whatsapp", "node_modules", ...PACKAGE.split("/"));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      main?: string;
    };
    const entry = path.join(pkgDir, pkg.main ?? "lib/index.js");
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

const requireFromHere = createRequire(import.meta.url);

let loaded: Baileys | null = null;

/**
 * Load the library (async import, so module mocks and ESM loaders apply). Called before a
 * WhatsApp socket is created; the sync accessor below covers helpers used afterwards. No
 * top-level await here: plugin sources are loaded through a CommonJS transform that rejects it.
 */
export async function loadBaileys(): Promise<Baileys> {
  if (loaded) {
    return loaded;
  }
  try {
    loaded = (await import("@whiskeysockets/baileys")) as Baileys;
    return loaded;
  } catch (err) {
    if (!isModuleNotFound(err)) {
      throw err;
    }
  }
  const entry = pluginBaileysEntry(path.join(CONFIG_DIR, "extensions"));
  if (!entry) {
    throw new WhatsAppRuntimeMissingError();
  }
  loaded = (await import(pathToFileURL(entry).href)) as Baileys;
  return loaded;
}

function requireBaileys(): Baileys | null {
  try {
    return requireFromHere("@whiskeysockets/baileys") as Baileys;
  } catch (err) {
    if (!isModuleNotFound(err)) {
      throw err;
    }
  }
  const entry = pluginBaileysEntry(path.join(CONFIG_DIR, "extensions"));
  return entry ? (requireFromHere(entry) as Baileys) : null;
}

/** True when the WhatsApp library can be used. */
export function hasBaileys(): boolean {
  try {
    baileys();
    return true;
  } catch {
    return false;
  }
}

/** The WhatsApp library; throws WhatsAppRuntimeMissingError when the plugin is not installed. */
export function baileys(): Baileys {
  if (!loaded) {
    loaded = requireBaileys();
  }
  if (!loaded) {
    throw new WhatsAppRuntimeMissingError();
  }
  return loaded;
}
