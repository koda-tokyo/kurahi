// Operations behind `kurahi policy …` (KoLo 2.0, M13d). Pure functions over a deps object so the
// CLI test can run them against a temp KOLO_HOME without a gateway. Every operator action is
// audited; secrets never print.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit, flushAudit } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import {
  readRegistryFile,
  resolveIntegrityLocations,
  updateRegistry,
} from "../integrity/registry.js";
import {
  addOwner,
  type AttestationResult,
  loadOrCreateOwnerKey,
  readOwnerKey,
  readOwners,
  signPolicyFile,
  verifyPolicyAttestation,
} from "../policy/attestation.js";
import { BudgetMeters } from "../policy/budgets.js";
import { PolicyEngine, type PolicyStatus } from "../policy/engine.js";
import { loadPolicyFile, parsePolicyText } from "../policy/load.js";
import {
  type PolicyLocations,
  type PolicyMode,
  resolvePolicyLocations,
  resolvePolicyMode,
} from "../policy/paths.js";
import { policyJsonSchema } from "../policy/schema.js";
import { starterPolicyYaml } from "../policy/starter.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export const POLICY_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export class PolicyCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = POLICY_EXIT.failed,
  ) {
    super(message);
    this.name = "PolicyCliError";
  }
}

export type GatewayCall = (
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> } | null>;

export type PolicyCliDeps = {
  runtime?: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  /** Reaches the running gateway; null when none is reachable. */
  gateway?: GatewayCall;
  now?: () => Date;
};

type Ctx = {
  runtime: RuntimeEnv;
  env: NodeJS.ProcessEnv;
  loc: PolicyLocations;
  mode: PolicyMode;
  gateway: GatewayCall;
  now: () => Date;
};

async function defaultGateway(env: NodeJS.ProcessEnv): Promise<GatewayCall> {
  return async (method, pathname, body) => {
    try {
      const { discover } = await import("@kodasoken/kurahi-client");
      const found = await discover({ env });
      if (!found.token) {
        return null;
      }
      const res = await fetch(`${found.baseUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${found.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      return { status: res.status, body: parsed };
    } catch {
      return null;
    }
  };
}

export async function makeCtx(deps: PolicyCliDeps = {}): Promise<Ctx> {
  const env = deps.env ?? process.env;
  let configured: string | undefined;
  try {
    configured = loadConfig().policy?.mode;
  } catch {
    configured = undefined;
  }
  return {
    runtime: deps.runtime ?? defaultRuntime,
    env,
    loc: resolvePolicyLocations(env),
    mode: resolvePolicyMode(env, configured),
    gateway: deps.gateway ?? (await defaultGateway(env)),
    now: deps.now ?? (() => new Date()),
  };
}

function operatorIdentity(): string {
  try {
    return `operator:${os.userInfo().username}`;
  } catch {
    return "operator";
  }
}

async function audit(action: string, outcome: "ok" | "failed", detail: Record<string, unknown>) {
  await appendAudit({
    identity: operatorIdentity(),
    device: os.hostname(),
    action,
    outcome,
    source: "cli",
    detail,
  }).catch(() => null);
  await flushAudit().catch(() => null);
}

/** Keep the integrity registry in step when it exists (the policy files are protected files). */
function reRegisterIntegrity(loc: PolicyLocations, env: NodeJS.ProcessEnv): string[] {
  const iloc = resolveIntegrityLocations(env);
  if (!readRegistryFile(iloc)) {
    return [];
  }
  const paths = [loc.policyPath, loc.signaturePath, loc.ownersPath].filter((p) => fs.existsSync(p));
  if (paths.length === 0) {
    return [];
  }
  const result = updateRegistry({ paths, loc: iloc });
  return result.changes.filter((c) => c.change !== "unchanged").map((c) => `${c.change} ${c.path}`);
}

function describeAttestation(att: AttestationResult): string {
  const who = att.keyId ? ` by ${att.keyId.slice(0, 12)}` : "";
  const when = att.signedAt ? ` at ${att.signedAt}` : "";
  return `${att.state}${who}${when}${att.reason ? ` (${att.reason})` : ""}`;
}

function resolveFile(loc: PolicyLocations, file?: string): string {
  return file ? path.resolve(file) : loc.policyPath;
}

// ── init ──────────────────────────────────────────────────────────────────────────────────

/** Write the starter policy, create (or reuse) the owner key, pin it and sign the policy. */
async function installStarterPolicy(
  loc: PolicyLocations,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  source = "policy.init",
) {
  fs.mkdirSync(loc.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(loc.policyPath, starterPolicyYaml(loc.home, [loc.ownerKeyPath]), {
    mode: 0o600,
  });
  const hadKey = readOwnerKey(loc.ownerKeyPath) !== null;
  const key = loadOrCreateOwnerKey(loc.ownerKeyPath);
  const pinned = addOwner(
    loc.ownersPath,
    { publicKey: key.publicKey, label: operatorIdentity() },
    now(),
  );
  const sig = signPolicyFile({
    policyPath: loc.policyPath,
    signaturePath: loc.signaturePath,
    key,
    now: now(),
  });
  const integrity = reRegisterIntegrity(loc, env);
  await audit(source, "ok", {
    path: loc.policyPath,
    keyId: key.keyId,
    createdKey: !hadKey,
    pinned,
    sha256: sig.sha256,
    integrity,
  });
  return { key, hadKey, pinned, sha256: sig.sha256, integrity };
}

/**
 * Secure default for new installations (`kurahi init`): install and sign the starter policy
 * (budgets and job limits) when no policy exists. An existing policy is never touched.
 */
export async function installStarterPolicyIfAbsent(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<{ installed: boolean; path: string; keyId?: string; createdKey?: boolean }> {
  const loc = resolvePolicyLocations(env);
  if (fs.existsSync(loc.policyPath)) {
    return { installed: false, path: loc.policyPath };
  }
  const { key, hadKey } = await installStarterPolicy(loc, env, now, "policy.init.default");
  return { installed: true, path: loc.policyPath, keyId: key.keyId, createdKey: !hadKey };
}

export async function runPolicyInit(
  opts: { force?: boolean; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const { loc, runtime } = ctx;
  if (fs.existsSync(loc.policyPath) && !opts.force) {
    throw new PolicyCliError(
      `policy already exists at ${loc.policyPath}; edit it and run \`kurahi policy sign\`, or pass --force to overwrite`,
    );
  }
  const { key, hadKey, pinned, integrity } = await installStarterPolicy(loc, ctx.env, ctx.now);
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          path: loc.policyPath,
          signature: loc.signaturePath,
          owners: loc.ownersPath,
          keyId: key.keyId,
          createdKey: !hadKey,
          mode: ctx.mode,
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log(
    [
      `policy      ${loc.policyPath}`,
      `signature   ${loc.signaturePath} (owner ${key.keyId.slice(0, 12)})`,
      `owners      ${loc.ownersPath}${pinned ? " (this key pinned)" : ""}`,
      `owner key   ${loc.ownerKeyPath}${hadKey ? "" : " (created, 0600; back it up off this machine)"}`,
      `mode        ${ctx.mode}`,
      ...integrity.map((line) => `integrity   ${line}`),
      "",
      "Next: edit the policy, then `kurahi policy validate` and `kurahi policy sign`. The gateway reloads it on save.",
    ].join("\n"),
  );
}

// ── show / validate / schema ──────────────────────────────────────────────────────────────

export async function runPolicyShow(opts: { file?: string; json?: boolean }, deps?: PolicyCliDeps) {
  const ctx = await makeCtx(deps);
  const file = resolveFile(ctx.loc, opts.file);
  const result = loadPolicyFile(ctx.loc, { path: file, attest: !opts.file });
  if (result.state === "absent") {
    throw new PolicyCliError(`no policy at ${file}. Create one with: kurahi policy init`);
  }
  if (result.state === "invalid") {
    throw new PolicyCliError(
      `policy invalid (${file}):\n${result.errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: true,
          path: file,
          sha256: result.sha256,
          attestation: result.attestation,
          mode: ctx.mode,
          policy: result.policy,
        },
        null,
        2,
      ),
    );
    return;
  }
  ctx.runtime.log(
    `# ${file}  sha256 ${result.sha256.slice(0, 12)}  attestation ${describeAttestation(result.attestation)}  mode ${ctx.mode}`,
  );
  ctx.runtime.log(fs.readFileSync(file, "utf8").trimEnd());
}

export async function runPolicyValidate(
  opts: { file?: string; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const file = resolveFile(ctx.loc, opts.file);
  if (!fs.existsSync(file)) {
    throw new PolicyCliError(`no policy at ${file}`);
  }
  const parsed = parsePolicyText(fs.readFileSync(file, "utf8"));
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: parsed.ok,
          path: file,
          errors: parsed.ok ? [] : parsed.errors,
          warnings: parsed.warnings,
        },
        null,
        2,
      ),
    );
  } else {
    for (const w of parsed.warnings) {
      ctx.runtime.log(`warning   ${w}`);
    }
    if (parsed.ok) {
      const agents = Object.keys(parsed.policy.agents ?? {}).length;
      ctx.runtime.log(
        `valid     ${file} (${agents} agent entr${agents === 1 ? "y" : "ies"}, ${parsed.warnings.length} warning(s))`,
      );
    } else {
      for (const e of parsed.errors) {
        ctx.runtime.log(`error     ${e}`);
      }
    }
  }
  if (!parsed.ok) {
    throw new PolicyCliError(`policy invalid: ${parsed.errors.length} error(s)`);
  }
}

export async function runPolicySchema(deps?: PolicyCliDeps) {
  const ctx = await makeCtx(deps);
  ctx.runtime.log(JSON.stringify(policyJsonSchema(), null, 2));
}

// ── sign / verify ─────────────────────────────────────────────────────────────────────────

export async function runPolicySign(
  opts: { file?: string; key?: string; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const file = resolveFile(ctx.loc, opts.file);
  if (!fs.existsSync(file)) {
    throw new PolicyCliError(`no policy at ${file}`);
  }
  const parsed = parsePolicyText(fs.readFileSync(file, "utf8"));
  if (!parsed.ok) {
    throw new PolicyCliError(
      `refusing to sign an invalid policy:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }
  const keyPath = opts.key ? path.resolve(opts.key) : ctx.loc.ownerKeyPath;
  const hadKey = readOwnerKey(keyPath) !== null;
  const key = loadOrCreateOwnerKey(keyPath);
  const pinned = addOwner(
    ctx.loc.ownersPath,
    { publicKey: key.publicKey, label: operatorIdentity() },
    ctx.now(),
  );
  const signaturePath = file === ctx.loc.policyPath ? ctx.loc.signaturePath : `${file}.sig`;
  const sig = signPolicyFile({ policyPath: file, signaturePath, key, now: ctx.now() });
  const integrity = file === ctx.loc.policyPath ? reRegisterIntegrity(ctx.loc, ctx.env) : [];
  await audit("policy.sign", "ok", {
    path: file,
    signature: signaturePath,
    keyId: key.keyId,
    sha256: sig.sha256,
    createdKey: !hadKey,
    pinned,
    integrity,
  });
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: true,
          path: file,
          signature: signaturePath,
          keyId: key.keyId,
          sha256: sig.sha256,
          signedAt: sig.signedAt,
          createdKey: !hadKey,
          pinned,
        },
        null,
        2,
      ),
    );
    return;
  }
  ctx.runtime.log(
    [
      `signed      ${file} (sha256 ${sig.sha256.slice(0, 12)})`,
      `signature   ${signaturePath}`,
      `owner       ${key.keyId.slice(0, 12)}${pinned ? " (pinned in owners.json)" : ""}${hadKey ? "" : " (key created, 0600; back it up)"}`,
      ...integrity.map((line) => `integrity   ${line}`),
    ].join("\n"),
  );
}

export async function runPolicyVerify(
  opts: { file?: string; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const file = resolveFile(ctx.loc, opts.file);
  if (!fs.existsSync(file)) {
    throw new PolicyCliError(`no policy at ${file}`);
  }
  const signaturePath = file === ctx.loc.policyPath ? ctx.loc.signaturePath : `${file}.sig`;
  const att = verifyPolicyAttestation({
    policyBytes: fs.readFileSync(file),
    signaturePath,
    ownersPath: ctx.loc.ownersPath,
  });
  const owners = readOwners(ctx.loc.ownersPath)?.owners ?? [];
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: att.state === "signed",
          path: file,
          signature: signaturePath,
          attestation: att,
          owners: owners.map((o) => ({ keyId: o.keyId, label: o.label })),
        },
        null,
        2,
      ),
    );
  } else {
    ctx.runtime.log(`attestation ${describeAttestation(att)}`);
    ctx.runtime.log(
      `owners      ${owners.length === 0 ? "none pinned" : owners.map((o) => `${o.keyId.slice(0, 12)}${o.label ? ` (${o.label})` : ""}`).join(", ")}`,
    );
  }
  if (att.state !== "signed") {
    throw new PolicyCliError(`policy is not attested (${att.state})`);
  }
}

// ── diff / apply ──────────────────────────────────────────────────────────────────────────

export type PolicyDiffLine = { op: "+" | "-" | "~"; path: string; from?: unknown; to?: unknown };

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function diffPolicies(from: unknown, to: unknown, prefix = ""): PolicyDiffLine[] {
  if (isObj(from) && isObj(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].toSorted();
    return keys.flatMap((key) =>
      diffPolicies(from[key], to[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  const same = JSON.stringify(from) === JSON.stringify(to);
  if (same) {
    return [];
  }
  if (from === undefined) {
    return [{ op: "+", path: prefix || "<root>", to }];
  }
  if (to === undefined) {
    return [{ op: "-", path: prefix || "<root>", from }];
  }
  return [{ op: "~", path: prefix || "<root>", from, to }];
}

function readCandidate(file: string) {
  if (!fs.existsSync(file)) {
    throw new PolicyCliError(`no file at ${file}`);
  }
  const parsed = parsePolicyText(fs.readFileSync(file, "utf8"));
  if (!parsed.ok) {
    throw new PolicyCliError(
      `${file} is not a valid policy:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }
  return parsed;
}

export async function runPolicyDiff(file: string, opts: { json?: boolean }, deps?: PolicyCliDeps) {
  const ctx = await makeCtx(deps);
  const candidate = readCandidate(path.resolve(file));
  const active = loadPolicyFile(ctx.loc, { attest: false });
  const activeDoc = active.state === "loaded" ? active.policy : {};
  const lines = diffPolicies(activeDoc, candidate.policy);
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        { ok: true, active: ctx.loc.policyPath, candidate: path.resolve(file), changes: lines },
        null,
        2,
      ),
    );
    return;
  }
  if (lines.length === 0) {
    ctx.runtime.log("no changes");
    return;
  }
  for (const line of lines) {
    const value =
      line.op === "~"
        ? `${JSON.stringify(line.from)} -> ${JSON.stringify(line.to)}`
        : JSON.stringify(line.op === "+" ? line.to : line.from);
    ctx.runtime.log(`${line.op} ${line.path}: ${value}`);
  }
}

export async function runPolicyApply(
  file: string,
  opts: { sign?: boolean; key?: string; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const source = path.resolve(file);
  const candidate = readCandidate(source);
  const candidateSig = `${source}.sig`;
  if (!opts.sign && !fs.existsSync(candidateSig)) {
    throw new PolicyCliError(
      `${candidateSig} is missing; sign the candidate first (kurahi policy sign ${file}) or pass --sign`,
      POLICY_EXIT.usage,
    );
  }
  const previous = loadPolicyFile(ctx.loc, { attest: false });
  const changes = diffPolicies(
    previous.state === "loaded" ? previous.policy : {},
    candidate.policy,
  );
  fs.mkdirSync(ctx.loc.dir, { recursive: true, mode: 0o700 });
  const tmp = `${ctx.loc.policyPath}.${process.pid}.tmp`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, ctx.loc.policyPath);
  if (opts.sign) {
    const key = loadOrCreateOwnerKey(opts.key ? path.resolve(opts.key) : ctx.loc.ownerKeyPath);
    addOwner(
      ctx.loc.ownersPath,
      { publicKey: key.publicKey, label: operatorIdentity() },
      ctx.now(),
    );
    signPolicyFile({
      policyPath: ctx.loc.policyPath,
      signaturePath: ctx.loc.signaturePath,
      key,
      now: ctx.now(),
    });
  } else {
    const tmpSig = `${ctx.loc.signaturePath}.${process.pid}.tmp`;
    fs.copyFileSync(candidateSig, tmpSig);
    fs.renameSync(tmpSig, ctx.loc.signaturePath);
  }
  const att = verifyPolicyAttestation({
    policyBytes: fs.readFileSync(ctx.loc.policyPath),
    signaturePath: ctx.loc.signaturePath,
    ownersPath: ctx.loc.ownersPath,
  });
  // Key rotation: a document signed by a pinned owner may pin further owners.
  let pinnedOwners = 0;
  if (att.state === "signed") {
    for (const publicKey of candidate.policy.attestation?.owners ?? []) {
      try {
        if (
          addOwner(ctx.loc.ownersPath, { publicKey, label: "policy.attestation.owners" }, ctx.now())
        ) {
          pinnedOwners += 1;
        }
      } catch {
        // an unparsable key is reported by validate, not here
      }
    }
  }
  const integrity = reRegisterIntegrity(ctx.loc, ctx.env);
  await audit("policy.apply", att.state === "signed" ? "ok" : "failed", {
    source,
    attestation: att.state,
    keyId: att.keyId ?? null,
    changes: changes.length,
    pinnedOwners,
    integrity,
  });
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: att.state === "signed",
          path: ctx.loc.policyPath,
          attestation: att,
          changes,
          pinnedOwners,
          mode: ctx.mode,
        },
        null,
        2,
      ),
    );
  } else {
    ctx.runtime.log(`applied     ${source} -> ${ctx.loc.policyPath} (${changes.length} change(s))`);
    ctx.runtime.log(`attestation ${describeAttestation(att)}`);
    for (const line of integrity) {
      ctx.runtime.log(`integrity   ${line}`);
    }
    ctx.runtime.log(
      ctx.mode === "enforce" && att.state !== "signed"
        ? "the gateway will refuse this document in enforce mode until it is signed by a pinned owner"
        : "the running gateway reloads the policy on save",
    );
  }
  if (att.state !== "signed") {
    throw new PolicyCliError(`applied document is not attested (${att.state})`);
  }
}

// ── status / kill / release / budget ──────────────────────────────────────────────────────

function localEngine(ctx: Ctx): PolicyEngine {
  const engine = new PolicyEngine({ loc: ctx.loc, mode: ctx.mode, now: ctx.now });
  engine.load({ source: "cli" });
  return engine;
}

function printStatus(ctx: Ctx, status: PolicyStatus, live: boolean) {
  const r = ctx.runtime;
  r.log(`source      ${live ? "gateway" : "local files (gateway not reachable)"}`);
  r.log(`mode        ${status.mode}`);
  r.log(
    `policy      ${status.loaded ? `${status.name ?? "unnamed"} (${status.sha256?.slice(0, 12)}, ${status.attestation}${status.attestedBy ? ` by ${status.attestedBy.slice(0, 12)}` : ""})` : status.refusedReason ? `refused: ${status.refusedReason}` : "none"}`,
  );
  r.log(
    `kill        ${
      status.kill.fleet
        ? `FLEET stopped by ${status.kill.fleet.by} at ${status.kill.fleet.at}`
        : Object.keys(status.kill.agents).length === 0
          ? "none"
          : Object.entries(status.kill.agents)
              .map(([a, m]) => `${a} (by ${m.by})`)
              .join(", ")
    }`,
  );
  const paused = Object.entries(status.paused).map(([a, p]) => `${a} (${p.rule})`);
  if (status.fleetPaused) {
    paused.unshift(`fleet (${status.fleetPaused.rule})`);
  }
  r.log(`paused      ${paused.length === 0 ? "none" : paused.join(", ")}`);
  for (const w of status.warnings) {
    r.log(`warning     ${w}`);
  }
}

export async function runPolicyStatus(
  opts: { json?: boolean; local?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const live = opts.local ? null : await ctx.gateway("GET", "/api/policy/status");
  const status =
    (live && live.status === 200 ? (live.body.status as PolicyStatus) : null) ??
    localEngine(ctx).status();
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        { ok: true, source: live?.status === 200 ? "gateway" : "local", status },
        null,
        2,
      ),
    );
    return;
  }
  printStatus(ctx, status, live?.status === 200);
}

function flipTarget(opts: { agent?: string; all?: boolean }): string | null {
  if (opts.all && opts.agent) {
    throw new PolicyCliError("pass --agent <id> or --all, not both", POLICY_EXIT.usage);
  }
  if (!opts.all && !opts.agent) {
    throw new PolicyCliError("pass --agent <id> or --all", POLICY_EXIT.usage);
  }
  return opts.all ? null : opts.agent!.trim().toLowerCase();
}

export async function runPolicyKill(
  opts: { agent?: string; all?: boolean; reason?: string; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const agent = flipTarget(opts);
  const by = operatorIdentity();
  // The file is the source of truth (survives restarts, watched by the gateway); the HTTP call
  // makes the stop immediate when a gateway is up.
  const local = localEngine(ctx).kill({ agent, by, reason: opts.reason });
  const live = await ctx.gateway("POST", "/api/policy/kill", {
    ...(agent ? { agent } : { all: true }),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  const jobsAborted = live?.status === 200 ? Number(live.body.jobsAborted ?? 0) : local.jobsAborted;
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: true,
          agent,
          by,
          live: live?.status === 200,
          jobsAborted,
          stateFile: ctx.loc.killStatePath,
        },
        null,
        2,
      ),
    );
    return;
  }
  ctx.runtime.log(
    `stopped     ${agent ?? "fleet"} (by ${by}${opts.reason ? `, ${opts.reason}` : ""})`,
  );
  ctx.runtime.log(
    live?.status === 200
      ? `gateway     applied now, ${jobsAborted} running job(s) aborted`
      : live
        ? `gateway     answered ${live.status}; the switch is written to ${ctx.loc.killStatePath} and the gateway applies it on reload`
        : `gateway     not reachable; the switch is written to ${ctx.loc.killStatePath} and applies when the gateway reads it`,
  );
  ctx.runtime.log(`release     kurahi policy release ${agent ? `--agent ${agent}` : "--all"}`);
}

export async function runPolicyRelease(
  opts: { agent?: string; all?: boolean; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const agent = flipTarget(opts);
  const by = operatorIdentity();
  const local = localEngine(ctx).release({ agent, by });
  const live = await ctx.gateway("POST", "/api/policy/release", agent ? { agent } : { all: true });
  const released = live?.status === 200 ? Boolean(live.body.released) : local.released;
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify({ ok: true, agent, by, live: live?.status === 200, released }, null, 2),
    );
    return;
  }
  ctx.runtime.log(`released    ${agent ?? "fleet"}${released ? "" : " (nothing was stopped)"}`);
  ctx.runtime.log(
    live?.status === 200
      ? "gateway     applied now"
      : "gateway     not reachable; the release is written locally and applies when the gateway reads it",
  );
}

export async function runPolicyBudget(
  opts: { agent?: string; reset?: boolean; json?: boolean },
  deps?: PolicyCliDeps,
) {
  const ctx = await makeCtx(deps);
  const engine = localEngine(ctx);
  const resetHourUtc = engine.document?.budgets?.resetHourUtc ?? 0;
  const meters = new BudgetMeters(ctx.loc.budgetsPath, { now: ctx.now, resetHourUtc });
  if (opts.reset) {
    meters.reset();
    meters.flush();
    await audit("policy.budget.reset", "ok", { file: ctx.loc.budgetsPath });
  }
  const snap = meters.snapshot();
  const currency = engine.document?.budgets?.currency ?? "USD";
  const agents = Object.keys({ ...snap.day.agents, ...snap.hour.agents })
    .filter((a) => !opts.agent || a === opts.agent)
    .toSorted();
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          ok: true,
          file: ctx.loc.budgetsPath,
          currency,
          limits: {
            fleet: engine.document?.budgets?.fleet ?? null,
            agents: engine.document?.budgets?.agents ?? {},
          },
          meters: snap,
          reset: Boolean(opts.reset),
        },
        null,
        2,
      ),
    );
    return;
  }
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
  const limitsFor = (agent: string | null) => {
    const l =
      agent === null
        ? engine.document?.budgets?.fleet
        : engine.budgetLimitsFor(agent).agent.at(-1)?.limits;
    return l
      ? ` / ${l.tokensPerDay ?? "-"} tok, ${l.costPerDay ?? "-"} ${currency}, ${l.toolCallsPerHour ?? "-"} calls (on breach: ${l.onBreach ?? "warn"})`
      : "";
  };
  ctx.runtime.log(
    `windows     day from ${snap.day.start} (reset ${String(resetHourUtc).padStart(2, "0")}:00 UTC), hour from ${snap.hour.start}`,
  );
  ctx.runtime.log(
    `fleet       ${snap.day.fleet.tokens} tok, ${fmt(snap.day.fleet.cost)} ${currency}, ${snap.hour.fleet.toolCalls} calls/h, ${snap.day.fleet.jobs} jobs${limitsFor(null)}${snap.fleetPaused ? `  PAUSED (${snap.fleetPaused.rule})` : ""}`,
  );
  for (const agent of agents) {
    const d = snap.day.agents[agent] ?? { tokens: 0, cost: 0, jobs: 0, toolCalls: 0 };
    const h = snap.hour.agents[agent] ?? { toolCalls: 0 };
    ctx.runtime.log(
      `${agent.padEnd(11)} ${d.tokens} tok, ${fmt(d.cost)} ${currency}, ${h.toolCalls} calls/h, ${d.jobs} jobs${limitsFor(agent)}${snap.paused[agent] ? `  PAUSED (${snap.paused[agent].rule})` : ""}`,
    );
  }
  if (agents.length === 0) {
    ctx.runtime.log("agents      no usage recorded in the current windows");
  }
  if (opts.reset) {
    ctx.runtime.log("reset       every counter zeroed (audited)");
  }
}

/** Shared by the CLI wiring: run an action, print one-line errors, map exit codes. */
export async function runPolicyAction(runtime: RuntimeEnv, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = err instanceof PolicyCliError ? err.exitCode : POLICY_EXIT.failed;
    runtime.error(`kurahi policy: ${err instanceof Error ? err.message : String(err)}`);
    runtime.exit(code);
  }
}
