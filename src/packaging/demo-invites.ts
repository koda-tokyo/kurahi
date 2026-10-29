// Demo invites for the private online demo (KURAHI_DEMO=1, see release-profile.ts).
//
// One invite = one person, one demonstration workspace (a Project) and an expiry. The visitor
// signs in with the invite link; there are no passwords to manage. An invite stays usable until
// it expires or is revoked, so a visitor can come back during the demo week, but a Project never
// has two live invites: two visitors would see each other's work.
//
// Mirrored to `<KOLO_HOME>/secrets/demo-invites.json` (0600, written atomically) after each
// mutation. Codes are stored hashed (SHA-256); the file never holds a usable invite code.
// The file is the source of truth and is re-read before every operation: the gateway keeps a
// long-lived store while the operator issues and revokes invites from another process, so a
// revoke must bite at once and a gateway write must never put back a stale copy. Every
// read-modify-write runs under `<file>.lock` (O_EXCL), so two processes never interleave one.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import { isProjectId } from "../projects/store.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { isDemoProfile } from "./release-profile.js";

export const DEMO_INVITES_FILENAME = "demo-invites.json";
export const DEMO_INVITE_CODE_PREFIX = "kdi_";
export const DEFAULT_DEMO_INVITE_DAYS = 7;
export const MAX_DEMO_INVITE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export type DemoInvite = {
  id: string;
  /** Who the invite is for, as the operator wrote it ("Tanaka, Example Corp"). */
  label: string;
  projectId: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
};

export type DemoInviteStatus = "active" | "expired" | "revoked";

export type DemoInviteDenial = {
  ok: false;
  reason:
    | "invalid_label"
    | "invalid_project"
    | "project_has_active_invite"
    | "unknown_code"
    | "expired"
    | "revoked"
    | "unknown_invite";
};

type StateFile = { version: 1; invites: Record<string, DemoInvite> };

export type DemoInviteStoreOptions = {
  /** `null` keeps the store in memory only (tests). */
  filePath?: string | null;
  now?: () => Date;
  audit?: typeof recordAuditEvent;
  /** How long a write waits for another process's lock before giving up. */
  lockTimeoutMs?: number;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string"
    ? raw
        .replace(/[\p{Cc}]/gu, "")
        .trim()
        .slice(0, max)
    : "";
}

export function defaultDemoInvitesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveKoloHome({ env }), "secrets", DEMO_INVITES_FILENAME);
}

/**
 * The sessions an invite's visitor may discover, attach to and drive: the chats of its own
 * Project only. Checked on the parsed session key, not a glob, because a session-allowlist `*`
 * also spans `:` and could reach keys outside the Project.
 */
export function demoInviteAdmitsSession(
  invite: Pick<DemoInvite, "projectId">,
  sessionKey: string,
): boolean {
  const ref = parseProjectSessionKey(sessionKey);
  return ref !== null && isProjectId(invite.projectId) && ref.projectId === invite.projectId;
}

/**
 * The WebSocket methods a signed-in demo visitor may call: its Project's chats and nothing
 * else. Each names exactly one session, by `sessionKey` (chat.*) or `key` (session.attach).
 */
const DEMO_VISITOR_METHODS: Record<string, "sessionKey" | "key"> = {
  "chat.send": "sessionKey",
  "chat.history": "sessionKey",
  "chat.abort": "sessionKey",
  "session.attach": "key",
};

/**
 * Why a demo visitor's request is refused, or null when it may run. Fail-closed: a method
 * outside the list, a missing session, a session outside the invite's Project, or a second
 * way of naming a target (agentId, channel/to) is refused.
 */
export function demoVisitorRequestError(
  invite: Pick<DemoInvite, "projectId">,
  method: string,
  params: Record<string, unknown>,
): string | null {
  const field = Object.hasOwn(DEMO_VISITOR_METHODS, method)
    ? DEMO_VISITOR_METHODS[method]
    : undefined;
  if (!field) {
    return "method not allowed for a demo invite";
  }
  for (const other of ["agentId", "channel", "to", "accountId"]) {
    if (params[other] !== undefined) {
      return "session not allowed for this demo invite";
    }
  }
  const value = params[field];
  const sessionKey = typeof value === "string" ? value.trim() : "";
  if (!sessionKey || !demoInviteAdmitsSession(invite, sessionKey)) {
    return "session not allowed for this demo invite";
  }
  return null;
}

/** Another process held the invites file past the lock timeout: transient, try again. */
export class DemoInvitesBusyError extends Error {
  constructor(cause?: unknown) {
    super("demo invites are busy; try again", { cause });
    this.name = "DemoInvitesBusyError";
  }
}

export class DemoInviteStore {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private readonly audit: typeof recordAuditEvent;
  private readonly lockTimeoutMs: number;
  private invites = new Map<string, DemoInvite>();
  private codeIndex = new Map<string, string>();

  constructor(opts: DemoInviteStoreOptions = {}) {
    this.filePath = opts.filePath === undefined ? defaultDemoInvitesPath() : opts.filePath;
    this.now = opts.now ?? (() => new Date());
    this.audit = opts.audit ?? recordAuditEvent;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.load();
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    this.invites.clear();
    this.codeIndex.clear();
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    let parsed: StateFile;
    try {
      parsed = JSON.parse(raw) as StateFile;
    } catch {
      throw new Error(`demo invites file is not valid JSON: ${this.filePath}`);
    }
    if (!parsed || parsed.version !== 1) {
      throw new Error(`demo invites file has an unsupported version: ${this.filePath}`);
    }
    for (const invite of Object.values(parsed.invites ?? {})) {
      this.invites.set(invite.id, invite);
      this.codeIndex.set(invite.codeHash, invite.id);
    }
  }

  /** Re-read the file and run `fn` holding its lock file (cross-process). Stale locks are broken. */
  private locked<T>(fn: () => T): T {
    if (!this.filePath) {
      return fn();
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    for (let attempt = 0; fd === null; attempt++) {
      try {
        fd = fs.openSync(lock, "wx", 0o600);
        fs.writeSync(fd, `${process.pid}\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new DemoInvitesBusyError(err);
        }
        sleepSync(Math.min(50, 5 * (attempt + 1)));
      }
    }
    try {
      this.load();
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }
    const state: StateFile = { version: 1, invites: Object.fromEntries(this.invites) };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        // best-effort; the file was created with mode 0600
      }
    }
    fs.renameSync(tmp, this.filePath);
  }

  private log(action: string, outcome: "allowed" | "denied", detail: Record<string, unknown>) {
    this.audit({ action, outcome, source: "demo.invites", detail });
  }

  status(invite: Pick<DemoInvite, "revokedAt" | "expiresAt">): DemoInviteStatus {
    if (invite.revokedAt) {
      return "revoked";
    }
    return Date.parse(invite.expiresAt) <= this.now().getTime() ? "expired" : "active";
  }

  list(): DemoInvite[] {
    this.load();
    return [...this.invites.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Issue an invite. The code is returned once; only its hash is kept. */
  create(params: {
    label: string;
    projectId: string;
    days?: number;
  }): { ok: true; invite: DemoInvite; code: string } | DemoInviteDenial {
    return this.locked(() => this.createLocked(params));
  }

  private createLocked(params: {
    label: string;
    projectId: string;
    days?: number;
  }): { ok: true; invite: DemoInvite; code: string } | DemoInviteDenial {
    const label = cleanText(params.label, 80);
    if (!label) {
      return { ok: false, reason: "invalid_label" };
    }
    const projectId = params.projectId;
    if (!isProjectId(projectId)) {
      return { ok: false, reason: "invalid_project" };
    }
    const taken = [...this.invites.values()].some(
      (invite) => invite.projectId === projectId && this.status(invite) === "active",
    );
    if (taken) {
      this.log("demo.invite.create", "denied", { projectId, reason: "project_has_active_invite" });
      return { ok: false, reason: "project_has_active_invite" };
    }
    const requested = Number.isFinite(params.days) ? Number(params.days) : DEFAULT_DEMO_INVITE_DAYS;
    const days = Math.max(1, Math.min(Math.floor(requested), MAX_DEMO_INVITE_DAYS));
    const code = `${DEMO_INVITE_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
    const nowMs = this.now().getTime();
    const invite: DemoInvite = {
      id: `dinv_${randomBytes(9).toString("base64url")}`,
      label,
      projectId,
      codeHash: sha256(code),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + days * DAY_MS).toISOString(),
    };
    this.invites.set(invite.id, invite);
    this.codeIndex.set(invite.codeHash, invite.id);
    this.persist();
    this.log("demo.invite.create", "allowed", { invite: invite.id, projectId, days });
    return { ok: true, invite, code };
  }

  /** Sign-in by invite link: the Project the visitor may open, while the invite is active. */
  resolve(code: string): { ok: true; invite: DemoInvite } | DemoInviteDenial {
    return this.locked(() => this.resolveLocked(code));
  }

  private resolveLocked(code: string): { ok: true; invite: DemoInvite } | DemoInviteDenial {
    const id = typeof code === "string" ? this.codeIndex.get(sha256(code)) : undefined;
    const invite = id ? this.invites.get(id) : undefined;
    if (!invite) {
      this.log("demo.invite.resolve", "denied", { reason: "unknown_code" });
      return { ok: false, reason: "unknown_code" };
    }
    const status = this.status(invite);
    if (status !== "active") {
      this.log("demo.invite.resolve", "denied", { invite: invite.id, reason: status });
      return { ok: false, reason: status };
    }
    invite.lastUsedAt = this.now().toISOString();
    this.persist();
    return { ok: true, invite };
  }

  /**
   * Re-check a signed-in visitor on every request, by invite id: a revoke or the expiry bites
   * at once. Read-only (no lastUsedAt write, no audit line per request).
   */
  check(id: string): { ok: true; invite: DemoInvite } | DemoInviteDenial {
    this.load();
    const invite = this.invites.get(id);
    if (!invite) {
      return { ok: false, reason: "unknown_invite" };
    }
    const status = this.status(invite);
    return status === "active" ? { ok: true, invite } : { ok: false, reason: status };
  }

  revoke(id: string): { ok: true; invite: DemoInvite } | DemoInviteDenial {
    return this.locked(() => this.revokeLocked(id));
  }

  private revokeLocked(id: string): { ok: true; invite: DemoInvite } | DemoInviteDenial {
    const invite = this.invites.get(id);
    if (!invite) {
      return { ok: false, reason: "unknown_invite" };
    }
    if (!invite.revokedAt) {
      invite.revokedAt = this.now().toISOString();
      this.persist();
      this.log("demo.invite.revoke", "allowed", { invite: id, projectId: invite.projectId });
    }
    return { ok: true, invite };
  }
}

/** What a signed-in demo visitor may ask for: chat in its own Project, never admin. */
export const DEMO_VISITOR_SCOPES: readonly string[] = ["operator.read", "operator.write"];

export function isDemoInviteCode(token: unknown): token is string {
  return typeof token === "string" && token.startsWith(DEMO_INVITE_CODE_PREFIX);
}

export type DemoVisitor = { inviteId: string; projectId: string };

/** What a visitor is told when its invite stops working: why, and what to do. */
export function demoInviteRefusalMessage(reason: string): string {
  if (reason === "busy") {
    return "unavailable: demo invites are busy; try again";
  }
  const why = reason === "expired" || reason === "revoked" ? reason : "not valid";
  return `unauthorized: demo invite ${why} (ask for a new invite link)`;
}

/**
 * The connect handshake with a `kdi_` invite code. Refused outside the demo profile, so a
 * stray invites file never opens a production gateway, and for any role but operator. The
 * scopes come from here, never from what the client asked for.
 */
export function authorizeDemoInviteConnect(params: {
  code: string;
  role: string;
  env?: Record<string, string | undefined>;
  store?: DemoInviteStore;
}):
  | { ok: true; visitor: DemoVisitor; scopes: string[] }
  | { ok: false; reason: `demo_${"disabled" | "role" | "busy" | DemoInviteDenial["reason"]}` } {
  if (!isDemoProfile(params.env)) {
    return { ok: false, reason: "demo_disabled" };
  }
  if (params.role !== "operator") {
    return { ok: false, reason: "demo_role" };
  }
  let resolved: ReturnType<DemoInviteStore["resolve"]>;
  try {
    resolved = (params.store ?? getDemoInviteStore()).resolve(params.code);
  } catch (err) {
    // The operator's CLI holds the file: a retryable refusal, not an ended invite.
    if (err instanceof DemoInvitesBusyError) {
      return { ok: false, reason: "demo_busy" };
    }
    throw err;
  }
  if (!resolved.ok) {
    return { ok: false, reason: `demo_${resolved.reason}` };
  }
  return {
    ok: true,
    visitor: { inviteId: resolved.invite.id, projectId: resolved.invite.projectId },
    scopes: [...DEMO_VISITOR_SCOPES],
  };
}

let shared: DemoInviteStore | null = null;

/** The gateway's store (created on first use at the default path). */
export function getDemoInviteStore(): DemoInviteStore {
  if (!shared) {
    shared = new DemoInviteStore();
  }
  return shared;
}

export function setDemoInviteStoreForTest(store: DemoInviteStore | null): void {
  shared = store;
}
