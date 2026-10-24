// AI inventory (Kurahi 2.0): one signed document listing every agent this runtime hosts, the models
// and providers it may call, its tools and sandbox, the policy rules that bind it, the MCP servers
// and channels it can reach, and how much evidence it has left. It is the "AI bill of materials"
// governance teams ask for first; Kurahi can produce it from facts because it is the runtime.
//
// Never included: secrets, environment values, request headers, command arguments, URL credentials
// or query strings, prompts, memory, or any evidence content. Only names, shapes and counts.
import os from "node:os";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { ManifestSigner } from "../continuity-suite/types.js";
import { listAgentIds, resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalJson,
  sha256Hex,
  type SigningKey,
  signerFromKey,
} from "../continuity-suite/manifest.js";
import { listEvidenceJobs } from "../evidence/store.js";
import {
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
import { matchingAgentEntries } from "../policy/decisions.js";
import { readKillState } from "../policy/kill.js";
import { loadPolicyFile } from "../policy/load.js";
import { nameMatches } from "../policy/match.js";
import { resolvePolicyLocations, resolvePolicyMode } from "../policy/paths.js";
import { VERSION } from "../version.js";

export const INVENTORY_KIND = "kolo-ai-inventory";
export const INVENTORY_VERSION = 1;

export type InventoryModel = { primary: string | null; fallbacks: string[]; providers: string[] };

export type InventoryAgent = {
  id: string;
  name: string | null;
  default: boolean;
  model: InventoryModel;
  tools: { profile: string | null; allow: string[]; deny: string[] };
  permissions: string[];
  sandbox: string;
  policy: {
    rules: string[];
    allowedProviders: string[] | null;
    allowedModels: string[] | null;
    allowedChannels: string[] | null;
    toolAllow: string[] | null;
    toolDeny: string[];
    approvals: string[];
    budget: boolean;
    stopped: boolean;
  };
  evidence: { jobs: number; lastStartedAt: string | null };
};

export type InventoryMcpServer = {
  id: string;
  transport: string;
  endpoint: string | null;
  enabled: boolean;
  allowTools: string[] | null;
};

export type InventoryBody = {
  kind: typeof INVENTORY_KIND;
  version: typeof INVENTORY_VERSION;
  generatedAt: string;
  runtime: { name: "Kurahi"; version: string; host: string | null };
  policy: {
    state: string;
    mode: string;
    sha256: string | null;
    attestation: string | null;
    fleetStopped: boolean;
  };
  agents: InventoryAgent[];
  mcpServers: InventoryMcpServer[];
  channels: Array<{ id: string; enabled: boolean }>;
  totals: {
    agents: number;
    models: number;
    providers: number;
    mcpServers: number;
    channels: number;
    evidenceJobs: number;
  };
};

export type Inventory = InventoryBody & {
  digest: string;
  signer?: ManifestSigner;
  signature?: string;
};

export type BuildInventoryOptions = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Include the machine's host name (off by default: inventories travel to third parties). */
  includeHost?: boolean;
  /** Skip reading evidence job counts (fast path for per-job configuration digests). */
  skipEvidenceStats?: boolean;
};

const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].filter(Boolean).toSorted();

function providerOf(ref: string): string {
  const i = ref.indexOf("/");
  return i > 0 ? ref.slice(0, i) : ref;
}

function modelRefs(raw: unknown): { primary: string | null; fallbacks: string[] } {
  if (typeof raw === "string") {
    return { primary: raw.trim() || null, fallbacks: [] };
  }
  if (raw && typeof raw === "object") {
    const m = raw as { primary?: unknown; fallbacks?: unknown };
    const primary = typeof m.primary === "string" ? m.primary.trim() || null : null;
    const fallbacks = Array.isArray(m.fallbacks)
      ? m.fallbacks.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    return { primary, fallbacks };
  }
  return { primary: null, fallbacks: [] };
}

/** Redacted endpoint: a stdio command's base name, or an HTTP URL's origin and path. */
export function redactEndpoint(server: { command?: string; url?: string }): string | null {
  if (server.url) {
    try {
      const u = new URL(server.url);
      return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "(invalid url)";
    }
  }
  if (server.command) {
    return path.basename(server.command.replaceAll("\\", "/"));
  }
  return null;
}

export function buildInventory(cfg: KoLoConfig, opts: BuildInventoryOptions = {}): InventoryBody {
  const env = opts.env ?? process.env;
  const loc = resolvePolicyLocations(env);
  const loaded = loadPolicyFile(loc);
  const policy = loaded.state === "loaded" ? loaded.policy : null;
  const mode = resolvePolicyMode(env, (cfg as { policy?: { mode?: string } }).policy?.mode);
  const kill = readKillState(loc.killStatePath);
  const fleetStopped = Boolean(kill.fleet) || policy?.kill?.fleet === true;

  let evidenceRows: ReturnType<typeof listEvidenceJobs> = [];
  try {
    evidenceRows = opts.skipEvidenceStats ? [] : listEvidenceJobs(env);
  } catch {
    evidenceRows = [];
  }

  const defaults = (cfg.agents?.defaults ?? {}) as { model?: unknown; sandbox?: { mode?: string } };
  const defaultModel = modelRefs(defaults.model);
  const defaultId = resolveDefaultAgentId(cfg);
  const listEntries = (cfg.agents?.list ?? []) as Array<{
    id?: string;
    permissions?: string[];
    tools?: { profile?: string; allow?: string[]; alsoAllow?: string[]; deny?: string[] };
  }>;

  const agents: InventoryAgent[] = listAgentIds(cfg).map((id) => {
    const resolved = resolveAgentConfig(cfg, id);
    const raw = listEntries.find((e) => e?.id?.trim().toLowerCase() === id);
    const own = modelRefs(resolved?.model);
    const model = own.primary || own.fallbacks.length > 0 ? own : defaultModel;
    const entries = matchingAgentEntries(policy, id);
    const pick = <T>(f: (e: (typeof entries)[number]["entry"]) => T | undefined): T | null => {
      for (const { entry } of entries) {
        const v = f(entry);
        if (v !== undefined) {
          return v;
        }
      }
      return null;
    };
    const approvals = uniqSorted(
      (policy?.approvals?.require ?? [])
        .filter((r) => !r.agents || r.agents.some((g) => nameMatches(g, id)))
        .map((r) => r.class),
    );
    const budget =
      Boolean(policy?.budgets?.fleet) ||
      Object.keys(policy?.budgets?.agents ?? {}).some((g) => nameMatches(g, id));
    const stopped =
      fleetStopped ||
      Boolean(kill.agents[id]) ||
      (policy?.kill?.agents ?? []).some((g) => nameMatches(g, id));
    const jobs = evidenceRows.filter((r) => r.agent === id);
    const refs = [model.primary, ...model.fallbacks].filter((x): x is string => Boolean(x));
    return {
      id,
      name: resolved?.name ?? null,
      default: id === defaultId,
      model: { ...model, providers: uniqSorted(refs.map(providerOf)) },
      tools: {
        profile: raw?.tools?.profile ?? null,
        allow: uniqSorted([...(raw?.tools?.allow ?? []), ...(raw?.tools?.alsoAllow ?? [])]),
        deny: uniqSorted(raw?.tools?.deny ?? []),
      },
      permissions: uniqSorted(raw?.permissions ?? []),
      sandbox: resolved?.sandbox?.mode ?? defaults.sandbox?.mode ?? "off",
      policy: {
        rules: entries.map((e) => e.key),
        allowedProviders: pick((e) => e.providers),
        allowedModels: pick((e) => e.models),
        allowedChannels: pick((e) => e.channels),
        toolAllow: pick((e) => e.tools?.allow),
        toolDeny: uniqSorted(entries.flatMap((e) => e.entry.tools?.deny ?? [])),
        approvals,
        budget,
        stopped,
      },
      evidence: { jobs: jobs.length, lastStartedAt: jobs[0]?.startedAt ?? null },
    };
  });

  const mcpServers: InventoryMcpServer[] = Object.entries(cfg.mcp?.servers ?? {})
    .map(([id, s]) => ({
      id,
      transport: s.transport,
      endpoint: redactEndpoint(s),
      enabled: s.enabled !== false,
      allowTools: s.allowTools ? uniqSorted(s.allowTools) : null,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const channels = Object.entries((cfg.channels ?? {}) as Record<string, unknown>)
    .filter(([id, v]) => id !== "defaults" && v !== null && typeof v === "object")
    .map(([id, v]) => ({ id, enabled: (v as { enabled?: unknown }).enabled !== false }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const allRefs = agents.flatMap((a) => [a.model.primary, ...a.model.fallbacks]);
  return {
    kind: INVENTORY_KIND,
    version: INVENTORY_VERSION,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    runtime: { name: "Kurahi", version: VERSION, host: opts.includeHost ? os.hostname() : null },
    policy: {
      state: loaded.state,
      mode,
      sha256: loaded.state === "loaded" ? loaded.sha256 : null,
      attestation: loaded.state === "loaded" ? loaded.attestation.state : null,
      fleetStopped,
    },
    agents,
    mcpServers,
    channels,
    totals: {
      agents: agents.length,
      models: uniqSorted(allRefs.filter((x): x is string => Boolean(x))).length,
      providers: uniqSorted(agents.flatMap((a) => a.model.providers)).length,
      mcpServers: mcpServers.length,
      channels: channels.length,
      evidenceJobs: evidenceRows.length,
    },
  };
}

export function inventoryDigest(body: InventoryBody): string {
  return sha256Hex(canonicalJson(body));
}

/**
 * Digest of the configuration an inventory describes, without its volatile parts (generation
 * time, evidence counts, host). Two jobs started under the same agents, models, tools, policy and
 * channels get the same value. Recorded in each job's `job.start` evidence.
 */
export function inventoryConfigDigest(
  cfg: KoLoConfig,
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  const body = buildInventory(cfg, { env: opts.env, skipEvidenceStats: true, now: new Date(0) });
  const stable: InventoryBody = {
    ...body,
    generatedAt: "",
    runtime: { ...body.runtime, host: null },
    agents: body.agents.map((a) => ({ ...a, evidence: { jobs: 0, lastStartedAt: null } })),
    totals: { ...body.totals, evidenceJobs: 0 },
  };
  return inventoryDigest(stable);
}

function signingInput(digest: string): string {
  return [INVENTORY_KIND, String(INVENTORY_VERSION), digest].join("\n");
}

function bodyOf(inv: Inventory): InventoryBody {
  const { digest: _d, signer: _s, signature: _g, ...body } = inv;
  return body;
}

export function finalizeInventory(body: InventoryBody, key?: SigningKey): Inventory {
  const digest = inventoryDigest(body);
  if (!key) {
    return { ...body, digest };
  }
  return {
    ...body,
    digest,
    signer: signerFromKey(key),
    signature: signDevicePayload(key.privateKeyPem, signingInput(digest)),
  };
}

export type InventoryVerification = {
  ok: boolean;
  digestOk: boolean;
  signed: boolean;
  keyIdOk: boolean;
  signatureOk: boolean;
  keyId: string | null;
};

export function verifyInventory(inv: Inventory): InventoryVerification {
  const digestOk = inv?.kind === INVENTORY_KIND && inventoryDigest(bodyOf(inv)) === inv.digest;
  const signed = Boolean(inv?.signer && inv?.signature);
  let keyIdOk = false;
  let signatureOk = false;
  if (signed) {
    keyIdOk =
      inv.signer!.alg === "ed25519" &&
      deriveDeviceIdFromPublicKey(inv.signer!.publicKey) === inv.signer!.keyId;
    if (keyIdOk) {
      try {
        signatureOk = verifyDeviceSignature(
          inv.signer!.publicKey,
          signingInput(inv.digest),
          inv.signature!,
        );
      } catch {
        signatureOk = false;
      }
    }
  }
  return {
    ok: digestOk && (!signed || (keyIdOk && signatureOk)),
    digestOk,
    signed,
    keyIdOk,
    signatureOk,
    keyId: inv?.signer?.keyId ?? null,
  };
}

const CSV_COLUMNS = [
  "agent",
  "name",
  "default",
  "primary_model",
  "fallback_models",
  "providers",
  "sandbox",
  "tool_profile",
  "policy_rules",
  "allowed_models",
  "approvals",
  "budget",
  "stopped",
  "evidence_jobs",
  "last_job_started",
] as const;

function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? ""
      : Array.isArray(v)
        ? v.join(" ")
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v as string | number | boolean);
  // Neutralise spreadsheet formulas and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** One row per agent, for spreadsheets and governance-platform imports. */
export function inventoryToCsv(inv: InventoryBody): string {
  const rows = inv.agents.map((a) =>
    [
      a.id,
      a.name,
      a.default,
      a.model.primary,
      a.model.fallbacks,
      a.model.providers,
      a.sandbox,
      a.tools.profile,
      a.policy.rules,
      a.policy.allowedModels,
      a.policy.approvals,
      a.policy.budget,
      a.policy.stopped,
      a.evidence.jobs,
      a.evidence.lastStartedAt,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
