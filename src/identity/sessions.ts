// SSO sessions: opaque bearer tokens (`kss_…`) for persons who signed in through the IdP.
//
// Only SHA-256 hashes are kept. A session ends at its absolute lifetime, after the idle timeout,
// on logout, or when the person is deactivated / deleted (SCIM) or an admin revokes it.
// Revocation listeners let open WebSocket connections close at once instead of at their next
// request. State is mirrored to `<KOLO_HOME>/identity/sessions.json` (0600) so a restart keeps
// sessions; expired entries are pruned on write.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { identityDir, writeJsonAtomic } from "./store.js";
import { SSO_SESSION_PREFIX, type SsoSession } from "./types.js";

export const SESSIONS_FILENAME = "sessions.json";
const MAX_SESSIONS = 20_000;
const KEEP_ENDED_MS = 24 * 3600_000;

export type SessionCheck =
  | { ok: true; session: SsoSession }
  | { ok: false; reason: "unknown" | "expired" | "idle" | "revoked" };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isSsoSessionToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SSO_SESSION_PREFIX) && value.length < 200;
}

type Listener = (session: SsoSession) => void;

export class SessionStore {
  private readonly filePath: string | null;
  private readonly now: () => number;
  private sessions = new Map<string, SsoSession>();
  private byHash = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(opts: { filePath?: string | null; now?: () => number } = {}) {
    this.filePath =
      opts.filePath === undefined ? path.join(identityDir(), SESSIONS_FILENAME) : opts.filePath;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const parsed = JSON.parse(raw) as { version?: number; sessions?: SsoSession[] };
    if (parsed?.version !== 1) {
      throw new Error(`identity sessions file has an unsupported version: ${this.filePath}`);
    }
    for (const s of parsed.sessions ?? []) {
      this.sessions.set(s.id, s);
      this.byHash.set(s.tokenHash, s.id);
    }
  }

  private persist(): void {
    const cutoff = this.now() - KEEP_ENDED_MS;
    for (const [id, s] of this.sessions) {
      const ended = s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
      if (ended < cutoff) {
        this.sessions.delete(id);
        this.byHash.delete(s.tokenHash);
      }
    }
    if (this.filePath) {
      // The OIDC ID token (logout hint) is a bearer-ish credential: it stays in memory only.
      // After a restart, RP-initiated logout goes without id_token_hint (client_id is sent).
      writeJsonAtomic(this.filePath, {
        version: 1,
        sessions: [...this.sessions.values()].map((s) => ({ ...s, idTokenHint: null })),
      });
    }
  }

  create(input: {
    personId: string;
    providerId: string;
    protocol: SsoSession["protocol"];
    lifetimeMs: number;
    idleMs: number;
    idTokenHint?: string | null;
    /** The IdP's own session end (SAML SessionNotOnOrAfter); the session never outlives it. */
    notAfterMs?: number | null;
  }): { token: string; session: SsoSession } {
    if (this.sessions.size >= MAX_SESSIONS) {
      this.persist();
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error("too many SSO sessions");
      }
    }
    const token = `${SSO_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const end = Math.min(now + input.lifetimeMs, input.notAfterMs ?? Number.POSITIVE_INFINITY);
    const session: SsoSession = {
      id: randomUUID(),
      tokenHash: hashSessionToken(token),
      personId: input.personId,
      providerId: input.providerId,
      protocol: input.protocol,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(end).toISOString(),
      idleTimeoutMs: input.idleMs,
      idTokenHint: input.idTokenHint ?? null,
      revokedAt: null,
      revokedReason: null,
    };
    this.sessions.set(session.id, session);
    this.byHash.set(session.tokenHash, session.id);
    this.persist();
    return { token, session };
  }

  /** Check a presented token; `touch` records activity (resets the idle timer). */
  verify(token: string, opts: { touch?: boolean } = {}): SessionCheck {
    if (!isSsoSessionToken(token)) {
      return { ok: false, reason: "unknown" };
    }
    const id = this.byHash.get(hashSessionToken(token));
    const session = id ? this.sessions.get(id) : undefined;
    return session ? this.check(session, opts.touch ?? false) : { ok: false, reason: "unknown" };
  }

  /** Re-check a session by id (open connections re-verify on every request). */
  verifyId(id: string, opts: { touch?: boolean } = {}): SessionCheck {
    const session = this.sessions.get(id);
    return session ? this.check(session, opts.touch ?? false) : { ok: false, reason: "unknown" };
  }

  private check(session: SsoSession, touch: boolean): SessionCheck {
    if (session.revokedAt) {
      return { ok: false, reason: "revoked" };
    }
    const now = this.now();
    if (Date.parse(session.expiresAt) <= now) {
      return { ok: false, reason: "expired" };
    }
    if (Date.parse(session.lastSeenAt) + session.idleTimeoutMs <= now) {
      this.revoke(session.id, "idle");
      return { ok: false, reason: "idle" };
    }
    if (touch) {
      // Activity is kept in memory; written with the next mutation (not on every request).
      session.lastSeenAt = new Date(now).toISOString();
    }
    return { ok: true, session };
  }

  get(id: string): SsoSession | null {
    return this.sessions.get(id) ?? null;
  }

  listForPerson(personId: string): SsoSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.personId === personId && !s.revokedAt && Date.parse(s.expiresAt) > this.now(),
    );
  }

  revoke(id: string, reason: string): SsoSession | null {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) {
      return null;
    }
    session.revokedAt = new Date(this.now()).toISOString();
    session.revokedReason = reason;
    session.idTokenHint = null;
    this.persist();
    for (const fn of this.listeners.get(id) ?? []) {
      try {
        fn(session);
      } catch {
        // a listener failure never blocks revocation
      }
    }
    this.listeners.delete(id);
    return session;
  }

  /** Revoke every live session of a person (deprovisioning, admin action). Returns the count. */
  revokePerson(personId: string, reason: string): number {
    let n = 0;
    for (const s of this.listForPerson(personId)) {
      if (this.revoke(s.id, reason)) {
        n += 1;
      }
    }
    return n;
  }

  /** Called when the session ends for any reason except expiry; returns the unsubscribe. */
  onRevoked(sessionId: string, fn: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }
}
