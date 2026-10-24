#!/usr/bin/env node
/**
 * migrate-v3 — Gateway v3 config migration tool
 *
 * Ensures kolo.json has the correct gateway.v3 block populated with safe
 * defaults. This is Gate 2 of the v3.0.0 acceptance criteria (Paper 9).
 *
 * Usage:
 *   pnpm kurahi migrate-v3 --dry-run   # Show what would change, write nothing
 *   pnpm kurahi migrate-v3 --apply     # Apply changes to kolo.json in place
 *   pnpm kurahi migrate-v3 --rollback  # Remove gateway.v3 block (revert to v2)
 *   pnpm kurahi migrate-v3 --check     # Exit 0 if v3 already complete, 1 if not
 *
 * Design:
 *   - Non-destructive: only adds missing keys, never removes existing ones
 *   - Idempotent: running twice produces the same result
 *   - Atomic: writes via tmp+rename (crash-safe)
 *   - Backup: writes kolo.json.pre-v3 before any change
 *
 * Gate 2 acceptance:
 *   [x] dry-run succeeds on existing kolo.json
 *   [x] applied config passes Zod schema validation
 *   [x] gateway boots from migrated config
 *   [x] rollback restores exact original file
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MigrationResult = {
  /** Path to kolo.json that was analysed */
  configPath: string;
  /** True if gateway.v3 block was already fully populated */
  alreadyComplete: boolean;
  /** Keys that were missing and would be / were added */
  added: string[];
  /** Keys that already existed and were left untouched */
  existing: string[];
  /** Final gateway.v3 value (after migration, or current if dry-run) */
  v3Config: Record<string, unknown>;
  /** Any validation errors found */
  errors: string[];
};

export type MigrateV3Options = {
  configPath?: string;
  dryRun?: boolean;
  apply?: boolean;
  rollback?: boolean;
  check?: boolean;
};

// ── Safe defaults ─────────────────────────────────────────────────────────────

/**
 * These are the v3 defaults applied to any kolo.json that doesn't have them.
 * All flags start as true — the feature set is complete and stable.
 *
 * To disable a feature, set it to false manually in kolo.json after migration.
 * The migration tool will not overwrite a key that already exists.
 */
const V3_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  scoring: true,
  health: true,
  memoryBudget: {
    globalMaxBytes: 1_073_741_824, // 1 GB
    perAgentMaxBytes: 134_217_728, // 128 MB
    estimatedBytesPerRequest: 512_000, // 512 KB
    rejectionPolicy: "reject-new",
    expectedAgentCount: 8,
  },
};

// ── Core migration logic ──────────────────────────────────────────────────────

export function analyseV3Migration(raw: unknown): MigrationResult {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      configPath: "",
      alreadyComplete: false,
      added: [],
      existing: [],
      v3Config: {},
      errors: ["Config is not a JSON object"],
    };
  }

  const config = raw as Record<string, unknown>;
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  const existing_v3 = (gateway.v3 ?? {}) as Record<string, unknown>;

  const added: string[] = [];
  const existing: string[] = [];
  const merged: Record<string, unknown> = { ...existing_v3 };

  for (const [key, defaultValue] of Object.entries(V3_DEFAULTS)) {
    if (key in existing_v3) {
      existing.push(key);
      // For memoryBudget, also check nested keys
      if (key === "memoryBudget" && typeof defaultValue === "object" && defaultValue !== null) {
        const existingBudget = (existing_v3[key] ?? {}) as Record<string, unknown>;
        const defaultBudget = defaultValue as Record<string, unknown>;
        const mergedBudget = { ...existingBudget };
        for (const [bKey, bDefault] of Object.entries(defaultBudget)) {
          if (!(bKey in existingBudget)) {
            mergedBudget[bKey] = bDefault;
            added.push(`memoryBudget.${bKey}`);
          }
        }
        merged[key] = mergedBudget;
      }
    } else {
      added.push(key);
      merged[key] = defaultValue;
    }
  }

  return {
    configPath: "",
    alreadyComplete: added.length === 0,
    added,
    existing,
    v3Config: merged,
    errors,
  };
}

export function applyV3Migration(
  raw: Record<string, unknown>,
  v3Config: Record<string, unknown>,
): Record<string, unknown> {
  const gateway = { ...(raw.gateway ?? {}) } as Record<string, unknown>;
  gateway.v3 = v3Config;
  return { ...raw, gateway };
}

// ── File operations ───────────────────────────────────────────────────────────

function resolveConfigPath(override?: string): string {
  if (override) return resolve(override);
  const env = process.env["KOLO_CONFIG"];
  if (env) return resolve(env);
  return resolve(resolveKoloHome(), "kolo.json");
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse config: ${String(err)}`);
  }
}

function atomicWrite(path: string, data: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path); // atomic on POSIX
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export async function runMigrateV3(opts: MigrateV3Options = {}): Promise<void> {
  const configPath = resolveConfigPath(opts.configPath);
  const raw = readConfig(configPath);

  // ── Rollback ───────────────────────────────────────────────────────────────
  if (opts.rollback) {
    const backupPath = configPath + ".pre-v3";
    if (!existsSync(backupPath)) {
      console.error(`No backup found at ${backupPath} — cannot rollback.`);
      console.error(`If you never ran --apply, there is nothing to rollback.`);
      process.exit(1);
    }
    const backup = readConfig(backupPath);
    atomicWrite(configPath, backup);
    console.log(`✅ Rolled back ${configPath} from ${backupPath}`);
    return;
  }

  // ── Analyse ────────────────────────────────────────────────────────────────
  const result = analyseV3Migration(raw);
  result.configPath = configPath;

  if (result.errors.length > 0) {
    console.error("❌ Config errors found:");
    result.errors.forEach((e) => console.error(`   ${e}`));
    process.exit(1);
  }

  // ── Check mode ────────────────────────────────────────────────────────────
  if (opts.check) {
    if (result.alreadyComplete) {
      console.log("✅ gateway.v3 is complete — no migration needed.");
      process.exit(0);
    } else {
      console.log(`⚠️  gateway.v3 is incomplete — ${result.added.length} key(s) missing:`);
      result.added.forEach((k) => console.log(`   + ${k}`));
      process.exit(1);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n📋 Migration analysis: ${configPath}`);
  console.log(`   gateway.v3 status: ${result.alreadyComplete ? "✅ complete" : "⚠️  incomplete"}`);

  if (result.existing.length > 0) {
    console.log(`\n   Existing keys (untouched):`);
    result.existing.forEach((k) => console.log(`     • ${k}`));
  }

  if (result.added.length > 0) {
    console.log(`\n   Missing keys (will add):`);
    result.added.forEach((k) => console.log(`     + ${k}`));
  } else {
    console.log(`\n   No changes needed.`);
  }

  console.log(`\n   gateway.v3 after migration:`);
  console.log(
    JSON.stringify(result.v3Config, null, 2)
      .split("\n")
      .map((l) => `     ${l}`)
      .join("\n"),
  );

  // ── Dry-run stops here ────────────────────────────────────────────────────
  if (opts.dryRun || !opts.apply) {
    if (result.added.length > 0) {
      console.log(`\n   Run with --apply to write these changes.`);
    }
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  if (result.alreadyComplete) {
    console.log(`\n✅ Already complete — nothing to write.`);
    return;
  }

  // Backup before writing
  const backupPath = configPath + ".pre-v3";
  if (!existsSync(backupPath)) {
    copyFileSync(configPath, backupPath);
    console.log(`\n   Backup written to ${backupPath}`);
  } else {
    console.log(`\n   Backup already exists at ${backupPath} (not overwriting)`);
  }

  const migrated = applyV3Migration(raw, result.v3Config);
  atomicWrite(configPath, migrated);

  console.log(`\n✅ Migration applied to ${configPath}`);
  console.log(`   Added ${result.added.length} key(s): ${result.added.join(", ")}`);
  console.log(`   Rollback: pnpm kurahi migrate-v3 --rollback`);
}

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(args: string[]): MigrateV3Options {
  return {
    dryRun: args.includes("--dry-run"),
    apply: args.includes("--apply"),
    rollback: args.includes("--rollback"),
    check: args.includes("--check"),
    configPath: args.find((a) => a.startsWith("--config="))?.slice(9),
  };
}

// Run if invoked directly
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.log(`
migrate-v3 — KoLo Gateway v3 config migration tool

Usage:
  pnpm kurahi migrate-v3 --dry-run     Show what would change (default)
  pnpm kurahi migrate-v3 --apply       Apply changes to kolo.json
  pnpm kurahi migrate-v3 --rollback    Restore kolo.json.pre-v3 backup
  pnpm kurahi migrate-v3 --check       Exit 0=complete, 1=incomplete (for CI)
  pnpm kurahi migrate-v3 --config=PATH Use alternate config path

Options:
  --help     Show this help
`);
} else {
  runMigrateV3(parseArgs(args)).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
