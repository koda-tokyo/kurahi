// Policy engine (KoLo 2.0, M13). One instance per process holds the active document, the runtime
// kill state and the budget meters, and answers `evaluate(point, ctx)` with allow | deny | ask |
// pause plus the rule id. Every decision is audited (`policy.decision`) with that rule id.
//
// Inert when no policy is loaded: every decision is `allow` by `default` and only the M5 config
// permissions (passed in by the tool guard) can refuse. Nothing runs at import time; the
// process-wide instance is created on first use and loads the document lazily.
import os from "node:os";
import type { BudgetLimits, PolicyDocument } from "./schema.js";
import { cancelJob, listJobs } from "../agents/jobs.js";
import { auditSafe } from "../audit/audit-log.js";
import { BudgetMeters, type BudgetBreach } from "./budgets.js";
import {
  AGENT_DRIVING_OPERATIONS,
  type ChannelContext,
  channelDecision,
  decide,
  type DecisionPoint,
  type JobContext,
  jobDecision,
  jobLimitsFor,
  reasoningExposureFor,
  killDecision,
  type ModelContext,
  modelDecision,
  type PolicyDecision,
  type RequestContext,
  requestDecision,
  type ToolContext,
  toolDecision,
} from "./decisions.js";
import { emptyKillState, type KillState, readKillState, writeKillState } from "./kill.js";
import { acceptPolicy, loadPolicyFile, type PolicyLoadResult } from "./load.js";
import { nameMatches } from "./match.js";
import {
  type PolicyLocations,
  type PolicyMode,
  resolvePolicyLocations,
  resolvePolicyMode,
} from "./paths.js";

export type PolicyEvent =
  | {
      type: "kill";
      agent: string | null;
      by: string;
      reason?: string;
      at: string;
      jobsAborted: number;
    }
  | { type: "release"; agent: string | null; by: string; at: string }
  | { type: "reload"; ok: boolean; sha256?: string; reason?: string; at: string }
  | { type: "budget"; agent: string | null; breach: BudgetBreach; ruleId: string; at: string };

export type PolicyStatus = {
  mode: PolicyMode;
  loaded: boolean;
  path: string;
  name?: string;
  sha256?: string;
  attestation?: string;
  attestedBy?: string;
  loadedAt?: string;
  refusedReason?: string;
  warnings: string[];
  kill: KillState;
  paused: Record<string, { since: string; rule: string }>;
  fleetPaused: { since: string; rule: string } | null;
};

export class PolicyGateError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "PolicyGateError";
  }
}

type EngineOptions = {
  loc?: PolicyLocations;
  mode?: PolicyMode;
  now?: () => Date;
  /** Keep meters in memory only (tests). */
  persist?: boolean;
  audit?: boolean;
};

export class PolicyEngine {
  readonly loc: PolicyLocations;
  mode: PolicyMode;
  private policy: PolicyDocument | null = null;
  private loadResult: PolicyLoadResult | null = null;
  private loadedAt: string | undefined;
  private refusedReason: string | undefined;
  private warnings: string[] = [];
  private killState: KillState;
  private meters: BudgetMeters;
  private readonly listeners = new Set<(evt: PolicyEvent) => void>();
  private readonly now: () => Date;
  private readonly persist: boolean;
  private readonly auditEnabled: boolean;
  private loadedOnce = false;

  constructor(opts: EngineOptions = {}) {
    this.loc = opts.loc ?? resolvePolicyLocations();
    this.mode = opts.mode ?? resolvePolicyMode();
    this.now = opts.now ?? (() => new Date());
    this.persist = opts.persist ?? true;
    this.auditEnabled = opts.audit ?? true;
    this.killState = this.persist ? readKillState(this.loc.killStatePath) : emptyKillState();
    this.meters = new BudgetMeters(this.persist ? this.loc.budgetsPath : null, { now: this.now });
  }

  // ── Loading ─────────────────────────────────────────────────────────────────────────────

  /**
   * (Re)load from disk. A refused document never replaces an accepted one at runtime; at boot
   * (`strict`) a refusal in enforce mode throws {@link PolicyGateError} so the gateway does not
   * start under an unattested policy.
   */
  load(opts: { strict?: boolean; source?: string } = {}): {
    ok: boolean;
    reason?: string;
    warnings: string[];
  } {
    this.loadedOnce = true;
    const result = loadPolicyFile(this.loc);
    const acceptance = acceptPolicy(result, this.mode);
    const at = this.now().toISOString();
    if (acceptance.accepted && result.state === "loaded") {
      const changed =
        this.loadResult?.state !== "loaded" || this.loadResult.sha256 !== result.sha256;
      this.policy = result.policy;
      this.loadResult = result;
      this.loadedAt = at;
      this.refusedReason = undefined;
      this.warnings = acceptance.warnings;
      this.meters = new BudgetMeters(this.persist ? this.loc.budgetsPath : null, {
        now: this.now,
        resetHourUtc: result.policy.budgets?.resetHourUtc ?? 0,
      });
      if (changed || opts.source) {
        this.audit("gateway", null, "policy.load", "ok", {
          source: opts.source ?? "load",
          path: result.path,
          sha256: result.sha256,
          attestation: result.attestation.state,
          keyId: result.attestation.keyId ?? null,
          warnings: acceptance.warnings,
        });
        this.emit({ type: "reload", ok: true, sha256: result.sha256, at });
      }
      return { ok: true, warnings: acceptance.warnings };
    }
    if (result.state === "absent" || this.mode === "off") {
      // Nothing to enforce; a previously loaded document (file removed at runtime) stays active.
      if (!this.policy) {
        this.refusedReason = undefined;
        this.warnings = acceptance.warnings;
      }
      return {
        ok: true,
        reason: acceptance.accepted ? undefined : acceptance.reason,
        warnings: acceptance.warnings,
      };
    }
    const reason = acceptance.accepted ? "unexpected" : acceptance.reason;
    this.audit("gateway", null, "policy.load", "failed", {
      source: opts.source ?? "load",
      path: result.path,
      reason,
      mode: this.mode,
      kept: this.policy ? ((this.loadResult as { sha256?: string } | null)?.sha256 ?? null) : null,
    });
    this.emit({ type: "reload", ok: false, reason, at });
    if (opts.strict && this.mode === "enforce") {
      throw new PolicyGateError(`policy gate: ${reason}`);
    }
    if (!this.policy) {
      this.refusedReason = reason;
      this.warnings = acceptance.warnings;
    }
    return { ok: false, reason, warnings: acceptance.warnings };
  }

  /** Install a document directly (tests, embedded hosts). Bypasses attestation. */
  useDocument(policy: PolicyDocument | null, meta: { sha256?: string } = {}): void {
    this.loadedOnce = true;
    this.policy = policy;
    this.loadResult = policy
      ? {
          state: "loaded",
          path: this.loc.policyPath,
          policy,
          sha256: meta.sha256 ?? "inline",
          bytes: 0,
          attestation: { state: "signed", keyId: "inline" },
          warnings: [],
        }
      : null;
    this.loadedAt = this.now().toISOString();
    this.refusedReason = undefined;
    this.meters = new BudgetMeters(this.persist ? this.loc.budgetsPath : null, {
      now: this.now,
      resetHourUtc: policy?.budgets?.resetHourUtc ?? 0,
    });
  }

  private ensureLoaded(): void {
    if (!this.loadedOnce) {
      this.load({ source: "lazy" });
    }
  }

  get document(): PolicyDocument | null {
    this.ensureLoaded();
    return this.policy;
  }

  get budgets(): BudgetMeters {
    return this.meters;
  }

  status(): PolicyStatus {
    this.ensureLoaded();
    const lr = this.loadResult;
    const snap = this.meters.snapshot();
    return {
      mode: this.mode,
      loaded: Boolean(this.policy),
      path: this.loc.policyPath,
      name: this.policy?.name,
      sha256: lr?.state === "loaded" ? lr.sha256 : undefined,
      attestation: lr?.state === "loaded" ? lr.attestation.state : undefined,
      attestedBy: lr?.state === "loaded" ? lr.attestation.keyId : undefined,
      loadedAt: this.loadedAt,
      refusedReason: this.refusedReason,
      warnings: [...this.warnings],
      kill: structuredClone(this.killState),
      paused: Object.fromEntries(
        Object.entries(snap.paused).map(([k, v]) => [k, { since: v.since, rule: v.rule }]),
      ),
      fleetPaused: snap.fleetPaused
        ? { since: snap.fleetPaused.since, rule: snap.fleetPaused.rule }
        : null,
    };
  }

  // ── Events + audit ──────────────────────────────────────────────────────────────────────

  onEvent(listener: (evt: PolicyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(evt: PolicyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch {
        // listeners never break a decision
      }
    }
  }

  private audit(
    identity: string | null,
    scope: string | null,
    action: string,
    outcome: string,
    detail: Record<string, unknown>,
  ): void {
    if (!this.auditEnabled) {
      return;
    }
    void auditSafe({ identity, scope, action, outcome, source: "policy.engine", detail });
  }

  private record(
    decision: PolicyDecision,
    ctx: { agentId?: string; sessionKey?: string },
    extra: Record<string, unknown>,
  ): PolicyDecision {
    const outcome =
      decision.effect === "allow"
        ? "ok"
        : decision.effect === "ask"
          ? "ask"
          : decision.effect === "pause"
            ? "paused"
            : "denied";
    this.audit(ctx.agentId ?? null, ctx.sessionKey ?? null, "policy.decision", outcome, {
      point: decision.point,
      effect: decision.effect,
      rule: decision.ruleId,
      reason: decision.reason,
      ...extra,
    });
    return decision;
  }

  // ── Budgets ─────────────────────────────────────────────────────────────────────────────

  private budgetDecision(point: DecisionPoint, agentId: string): PolicyDecision | null {
    const pausedRule = this.meters.pausedBy(agentId);
    if (pausedRule) {
      return decide(point, "pause", pausedRule, `${agentId} is paused by a budget breach`);
    }
    const policy = this.policy;
    if (!policy?.budgets) {
      return null;
    }
    const candidates: Array<{ breach: BudgetBreach; ruleId: string }> = [];
    for (const b of this.meters.breaches({ scope: "fleet", limits: policy.budgets.fleet })) {
      candidates.push({ breach: b, ruleId: `budgets.fleet.${b.metric}` });
    }
    for (const [key, limits] of Object.entries(policy.budgets.agents ?? {})) {
      if (!nameMatches(key, agentId)) {
        continue;
      }
      for (const b of this.meters.breaches({ scope: "agent", agent: agentId, limits })) {
        candidates.push({ breach: b, ruleId: `budgets.agents[${key}].${b.metric}` });
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    const rank = { stop: 3, pause: 2, warn: 1 } as const;
    candidates.sort((a, b) => rank[b.breach.action] - rank[a.breach.action]);
    const { breach, ruleId } = candidates[0];
    const at = this.now().toISOString();
    const detail = `${breach.metric} ${breach.used} >= ${breach.limit} (${breach.scope === "fleet" ? "fleet" : agentId})`;
    this.emit({
      type: "budget",
      agent: breach.scope === "fleet" ? null : agentId,
      breach,
      ruleId,
      at,
    });
    if (breach.action === "stop") {
      return decide(point, "deny", ruleId, `budget exceeded: ${detail}`);
    }
    if (breach.action === "pause") {
      const window = breach.metric === "toolCallsPerHour" ? "hour" : "day";
      this.meters.pause(breach.scope === "fleet" ? null : agentId, ruleId, window);
      return decide(
        point,
        "pause",
        ruleId,
        `budget exceeded, paused until release or the next window: ${detail}`,
      );
    }
    this.audit(agentId, null, "policy.budget", "warn", { rule: ruleId, ...breach });
    return null;
  }

  /** Usage after a model turn / tool call; feeds the meters the next decision reads. */
  recordUsage(
    agentId: string,
    usage: { tokens?: number; cost?: number; toolCalls?: number; jobs?: number },
  ): void {
    this.ensureLoaded();
    this.meters.record(agentId, usage);
  }

  budgetLimitsFor(agentId: string): {
    fleet?: BudgetLimits;
    agent: Array<{ key: string; limits: BudgetLimits }>;
  } {
    this.ensureLoaded();
    const agent = Object.entries(this.policy?.budgets?.agents ?? {})
      .filter(([key]) => nameMatches(key, agentId))
      .map(([key, limits]) => ({ key, limits }));
    return { fleet: this.policy?.budgets?.fleet, agent };
  }

  /** `false` when the policy forbids streaming this agent's reasoning; undefined otherwise. */
  reasoningExposure(agentId: string): false | undefined {
    // Like every other clause, the document only binds in enforce mode.
    if (this.mode !== "enforce") {
      return undefined;
    }
    this.ensureLoaded();
    return reasoningExposureFor(this.policy, agentId);
  }

  jobLimits(agentId: string): ReturnType<typeof jobLimitsFor> {
    this.ensureLoaded();
    return jobLimitsFor(this.policy, agentId);
  }

  // ── Decision points ─────────────────────────────────────────────────────────────────────

  evaluate(point: "tool", ctx: ToolContext): PolicyDecision;
  evaluate(point: "model", ctx: ModelContext): PolicyDecision;
  evaluate(point: "channel", ctx: ChannelContext): PolicyDecision;
  evaluate(point: "request", ctx: RequestContext): PolicyDecision;
  evaluate(point: "job", ctx: JobContext): PolicyDecision;
  evaluate(
    point: DecisionPoint,
    ctx: ToolContext | ModelContext | ChannelContext | RequestContext | JobContext,
  ): PolicyDecision {
    this.ensureLoaded();
    if (this.mode === "off") {
      return decide(point, "allow", "mode:off", "policy mode is off");
    }
    const policy = this.policy;
    switch (point) {
      case "tool": {
        const c = ctx as ToolContext;
        const summary = { tool: c.tool, mcpServer: c.mcpServer ?? null };
        const killed = killDecision(point, policy, this.killState, c.agentId);
        if (killed) {
          return this.record(killed, c, summary);
        }
        const budget = this.budgetDecision(point, c.agentId);
        if (budget) {
          return this.record(budget, c, summary);
        }
        // `~/` in data.neverRead / neverWrite is the operating-system user's home (where ~/.ssh
        // lives), not the state directory: the tools run as that user.
        const decision = toolDecision(policy, c, os.homedir());
        if (decision.effect === "allow") {
          this.meters.record(c.agentId, { toolCalls: 1 });
        }
        return this.record(decision, c, summary);
      }
      case "model": {
        const c = ctx as ModelContext;
        const summary = { provider: c.provider, model: c.model };
        const killed = killDecision(point, policy, this.killState, c.agentId);
        if (killed) {
          return this.record(killed, c, summary);
        }
        const budget = this.budgetDecision(point, c.agentId);
        if (budget) {
          return this.record(budget, c, summary);
        }
        return this.record(modelDecision(policy, c), c, summary);
      }
      case "channel": {
        const c = ctx as ChannelContext;
        const summary = { channel: c.channel, direction: c.direction, target: c.target ?? null };
        const killed = killDecision(point, policy, this.killState, c.agentId);
        if (killed) {
          return this.record(killed, c, summary);
        }
        return this.record(channelDecision(policy, c), c, summary);
      }
      case "request": {
        const c = ctx as RequestContext;
        const summary = { surface: c.surface, operation: c.operation, scope: c.scope ?? null };
        const drives = AGENT_DRIVING_OPERATIONS.includes(c.operation);
        const killed = drives ? killDecision(point, policy, this.killState, c.agentId) : null;
        if (killed) {
          return this.record(killed, c, summary);
        }
        const decision = requestDecision(policy, c);
        // Allowed requests are not audited one by one: the HTTP/WS layers already log them.
        return decision.effect === "allow" ? decision : this.record(decision, c, summary);
      }
      case "job": {
        const c = ctx as JobContext;
        const summary = { kind: c.kind, runningJobs: c.runningJobs ?? null };
        const killed = killDecision(point, policy, this.killState, c.agentId);
        if (killed) {
          return this.record(killed, c, summary);
        }
        const budget = this.budgetDecision(point, c.agentId);
        if (budget) {
          return this.record(budget, c, summary);
        }
        const decision = jobDecision(policy, c);
        if (decision.effect === "allow") {
          this.meters.record(c.agentId, { jobs: 1 });
        }
        return this.record(decision, c, summary);
      }
    }
  }

  // ── Kill switch ─────────────────────────────────────────────────────────────────────────

  /** Who may flip the switch (policy `kill.mayFlip`, default owner + admin). */
  mayFlip(scope: string): boolean {
    this.ensureLoaded();
    const allowed = this.policy?.kill?.mayFlip ?? ["owner", "admin"];
    return (allowed as readonly string[]).includes(scope);
  }

  /** Re-read the runtime kill file (written by another process, e.g. `kurahi policy kill`). */
  reloadKillState(): KillState {
    this.ensureLoaded();
    if (this.persist) {
      this.killState = readKillState(this.loc.killStatePath);
    }
    return structuredClone(this.killState);
  }

  isKilled(agentId?: string): boolean {
    this.ensureLoaded();
    return killDecision("job", this.policy, this.killState, agentId) !== null;
  }

  /**
   * Stop one agent or the fleet. Synchronous end to end: state written, running jobs aborted
   * through their cancel handles (runAbortController), listeners told — all in this tick.
   */
  kill(params: { agent?: string | null; by: string; reason?: string }): { jobsAborted: number } {
    this.ensureLoaded();
    const agent = params.agent?.trim() || null;
    const at = this.now().toISOString();
    const mark = { by: params.by, at, ...(params.reason ? { reason: params.reason } : {}) };
    if (agent) {
      this.killState.agents[agent] = mark;
    } else {
      this.killState.fleet = mark;
    }
    if (this.persist) {
      writeKillState(this.loc.killStatePath, this.killState);
    }
    let jobsAborted = 0;
    for (const job of listJobs({ limit: 500, ...(agent ? { agent } : {}) })) {
      if (job.status !== "queued" && job.status !== "running") {
        continue;
      }
      const result = cancelJob(job.id, { requestedBy: `policy.kill:${params.by}` });
      if (result.ok) {
        jobsAborted += 1;
      }
    }
    this.audit(params.by, null, "policy.kill", "ok", {
      agent,
      reason: params.reason ?? null,
      jobsAborted,
    });
    this.emit({ type: "kill", agent, by: params.by, reason: params.reason, at, jobsAborted });
    return { jobsAborted };
  }

  release(params: { agent?: string | null; by: string; authn?: Record<string, unknown> | null }): {
    released: boolean;
  } {
    this.ensureLoaded();
    const agent = params.agent?.trim() || null;
    let released = false;
    if (agent) {
      released = Boolean(this.killState.agents[agent]);
      delete this.killState.agents[agent];
      released = this.meters.release(agent) || released;
    } else {
      released = Boolean(this.killState.fleet) || Object.keys(this.killState.agents).length > 0;
      this.killState = emptyKillState();
      released = this.meters.release() || released;
    }
    if (this.persist) {
      writeKillState(this.loc.killStatePath, this.killState);
    }
    const at = this.now().toISOString();
    this.audit(params.by, null, "policy.release", "ok", {
      agent,
      released,
      ...(params.authn ? { authn: params.authn } : {}),
    });
    this.emit({ type: "release", agent, by: params.by, at });
    return { released };
  }
}

// ── Process-wide instance ────────────────────────────────────────────────────────────────

let instance: PolicyEngine | null = null;

export function getPolicyEngine(): PolicyEngine {
  if (!instance) {
    instance = new PolicyEngine();
  }
  return instance;
}

/** Gateway boot: pick the mode from config, load strictly (exit 3 on a refused policy). */
export function initPolicyEngine(opts: { mode?: PolicyMode; strict?: boolean } = {}): PolicyEngine {
  const engine = new PolicyEngine({ mode: opts.mode });
  instance = engine;
  engine.load({ strict: opts.strict ?? false, source: "boot" });
  return engine;
}

export function setPolicyEngineForTest(engine: PolicyEngine | null): void {
  instance = engine;
}
