// Built-in authenticators of persons: passkeys (WebAuthn credentials), authenticator-app secrets
// (TOTP) and the one-time enrollment codes identity admins issue.
//
// State lives in memory and is mirrored to `<KOLO_HOME>/identity/authenticators.json` (0600,
// written atomically), loaded on first use. Passkeys keep only public keys. TOTP secrets are
// encrypted with AES-256-GCM under a data key held in the Kurahi secrets store
// (`identity.authenticators.key`, created on first use), bound to the person by the GCM
// associated data; enrollment codes are kept as SHA-256 hashes only. One writer: the gateway.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSecretStore } from "../secrets/store.js";
import { IdentityError, identityDir, writeJsonAtomic } from "./store.js";

export const AUTHENTICATORS_FILENAME = "authenticators.json";
export const AUTHENTICATORS_KEY_SECRET = "identity.authenticators.key";
export const ENROLLMENT_CODE_PREFIX = "kpe_";
export const MAX_PASSKEYS_PER_PERSON = 10;
const MAX_ENROLLMENTS = 5_000;
const MAX_PENDING_ENROLLMENTS_PER_PERSON = 5;
const KEEP_ENDED_ENROLLMENTS_MS = 30 * 24 * 3600_000;

export type PasskeyCredential = {
  /** Credential id (base64url). */
  id: string;
  personId: string;
  /** SPKI DER (base64url) of the COSE key the authenticator registered. */
  publicKey: string;
  /** COSE algorithm (-7 ES256, -8 EdDSA, -257 RS256). */
  alg: number;
  signCount: number;
  transports: string[];
  /** Synced passkey (backup eligible): `swk`; device-bound: `hwk`. */
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: string;
  label: string;
  /** "admin": set up with an identity admin's enrollment code; "self": by the signed-in person. */
  enrolledVia?: "admin" | "self";
  createdAt: string;
  lastUsedAt: string | null;
};

type EncryptedSecret = { iv: string; tag: string; ct: string };

type TotpRecord = {
  personId: string;
  secret: EncryptedSecret;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The last TOTP step accepted: a code for it (or an earlier step) never works again. */
  lastStep: number | null;
  enrolledVia?: "admin" | "self";
};

export type Enrollment = {
  id: string;
  personId: string;
  codeHash: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
  /** What the code enrolled: "passkey" or "totp". */
  usedFor: string | null;
  revokedAt: string | null;
};

export type EnrollmentState = "pending" | "used" | "revoked" | "expired";

type AuthenticatorsFile = {
  version: 1;
  /** WebAuthn user handle per person (random, never personal data). */
  handles: Record<string, string>;
  credentials: PasskeyCredential[];
  totp: TotpRecord[];
  enrollments: Enrollment[];
};

/** Where the TOTP data key comes from (the secrets store by default; tests inject one). */
export type DataKeyProvider = () => Buffer;

export function secretStoreDataKey(): Buffer {
  const store = resolveSecretStore();
  let value = store.get(AUTHENTICATORS_KEY_SECRET);
  if (!value) {
    value = randomBytes(32).toString("base64");
    store.set(AUTHENTICATORS_KEY_SECRET, value);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new IdentityError("invalid", `${AUTHENTICATORS_KEY_SECRET} must be 32 bytes (base64)`);
  }
  return key;
}

const sha256hex = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

export class AuthenticatorStore {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private readonly dataKey: DataKeyProvider;
  private loaded = false;
  private handles = new Map<string, string>();
  private credentials = new Map<string, PasskeyCredential>();
  private totp = new Map<string, TotpRecord>();
  private enrollments = new Map<string, Enrollment>();

  constructor(
    opts: { filePath?: string | null; now?: () => Date; dataKey?: DataKeyProvider } = {},
  ) {
    this.filePath =
      opts.filePath === undefined
        ? path.join(identityDir(), AUTHENTICATORS_FILENAME)
        : opts.filePath;
    this.now = opts.now ?? (() => new Date());
    this.dataKey = opts.dataKey ?? secretStoreDataKey;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!this.filePath) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const parsed = JSON.parse(raw) as AuthenticatorsFile;
    if (parsed?.version !== 1) {
      throw new Error(`identity authenticators file has an unsupported version: ${this.filePath}`);
    }
    for (const [personId, handle] of Object.entries(parsed.handles ?? {})) {
      this.handles.set(personId, handle);
    }
    for (const c of parsed.credentials ?? []) {
      this.credentials.set(c.id, c);
    }
    for (const t of parsed.totp ?? []) {
      this.totp.set(t.personId, t);
    }
    for (const e of parsed.enrollments ?? []) {
      this.enrollments.set(e.id, e);
    }
  }

  private persist(): void {
    const cutoff = this.now().getTime() - KEEP_ENDED_ENROLLMENTS_MS;
    for (const [id, e] of this.enrollments) {
      if (this.stateOf(e) !== "pending" && Date.parse(e.expiresAt) < cutoff) {
        this.enrollments.delete(id);
      }
    }
    if (!this.filePath) {
      return;
    }
    const state: AuthenticatorsFile = {
      version: 1,
      handles: Object.fromEntries(this.handles),
      credentials: [...this.credentials.values()],
      totp: [...this.totp.values()],
      enrollments: [...this.enrollments.values()],
    };
    writeJsonAtomic(this.filePath, state);
  }

  // ── user handles ───────────────────────────────────────────────────────────────────────

  /** The person's WebAuthn user handle (base64url, 32 random bytes); created on first use. */
  userHandle(personId: string): string {
    this.load();
    let handle = this.handles.get(personId);
    if (!handle) {
      handle = randomBytes(32).toString("base64url");
      this.handles.set(personId, handle);
      this.persist();
    }
    return handle;
  }

  peekUserHandle(personId: string): string | null {
    this.load();
    return this.handles.get(personId) ?? null;
  }

  // ── passkeys ───────────────────────────────────────────────────────────────────────────

  listPasskeys(personId: string): PasskeyCredential[] {
    this.load();
    return [...this.credentials.values()]
      .filter((c) => c.personId === personId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getPasskey(id: string): PasskeyCredential | null {
    this.load();
    return this.credentials.get(id) ?? null;
  }

  addPasskey(input: Omit<PasskeyCredential, "createdAt" | "lastUsedAt">): PasskeyCredential {
    this.load();
    if (this.credentials.has(input.id)) {
      throw new IdentityError("conflict", "this passkey is already registered");
    }
    if (this.listPasskeys(input.personId).length >= MAX_PASSKEYS_PER_PERSON) {
      throw new IdentityError("limit", `at most ${MAX_PASSKEYS_PER_PERSON} passkeys per person`);
    }
    const cred: PasskeyCredential = {
      ...input,
      label: input.label.trim().slice(0, 64) || "Passkey",
      createdAt: this.iso(),
      lastUsedAt: null,
    };
    this.credentials.set(cred.id, cred);
    this.persist();
    return cred;
  }

  /** Record a successful assertion (new signature counter). */
  recordPasskeyUse(id: string, signCount: number): void {
    this.load();
    const cred = this.credentials.get(id);
    if (!cred) {
      return;
    }
    cred.signCount = signCount;
    cred.lastUsedAt = this.iso();
    this.persist();
  }

  removePasskey(id: string): PasskeyCredential {
    this.load();
    const cred = this.credentials.get(id);
    if (!cred) {
      throw new IdentityError("not_found", "passkey not found");
    }
    this.credentials.delete(id);
    this.persist();
    return cred;
  }

  // ── one-time codes (TOTP) ──────────────────────────────────────────────────────────────

  hasTotp(personId: string): boolean {
    this.load();
    return this.totp.has(personId);
  }

  totpInfo(personId: string): {
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    enrolledVia: "admin" | "self";
  } | null {
    this.load();
    const t = this.totp.get(personId);
    return t
      ? {
          label: t.label,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
          enrolledVia: t.enrolledVia ?? "self",
        }
      : null;
  }

  private aad(personId: string): Buffer {
    return Buffer.from(`kurahi-totp:v1:${personId}`, "utf8");
  }

  /** Store (or replace) the person's authenticator-app secret, encrypted. */
  setTotp(
    personId: string,
    secret: Buffer,
    label: string,
    enrolledVia: "admin" | "self" = "self",
  ): void {
    this.load();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey(), iv);
    cipher.setAAD(this.aad(personId));
    const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
    this.totp.set(personId, {
      personId,
      secret: {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      },
      label: label.trim().slice(0, 64) || "Authenticator app",
      createdAt: this.iso(),
      lastUsedAt: null,
      lastStep: null,
      enrolledVia,
    });
    this.persist();
  }

  /** The decrypted secret and the last accepted step, or null when none is enrolled. */
  readTotp(personId: string): { secret: Buffer; lastStep: number | null } | null {
    this.load();
    const t = this.totp.get(personId);
    if (!t) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.dataKey(),
      Buffer.from(t.secret.iv, "base64"),
    );
    decipher.setAAD(this.aad(personId));
    decipher.setAuthTag(Buffer.from(t.secret.tag, "base64"));
    const secret = Buffer.concat([
      decipher.update(Buffer.from(t.secret.ct, "base64")),
      decipher.final(),
    ]);
    return { secret, lastStep: t.lastStep };
  }

  recordTotpUse(personId: string, step: number): void {
    this.load();
    const t = this.totp.get(personId);
    if (!t) {
      return;
    }
    t.lastStep = Math.max(step, t.lastStep ?? step);
    t.lastUsedAt = this.iso();
    this.persist();
  }

  removeTotp(personId: string): boolean {
    this.load();
    const had = this.totp.delete(personId);
    if (had) {
      this.persist();
    }
    return had;
  }

  /** Forget everything a deleted person had (passkeys, TOTP, handle, pending codes). */
  removePerson(personId: string): number {
    this.load();
    let n = 0;
    for (const [id, c] of this.credentials) {
      if (c.personId === personId) {
        this.credentials.delete(id);
        n += 1;
      }
    }
    n += this.totp.delete(personId) ? 1 : 0;
    this.handles.delete(personId);
    for (const e of this.enrollments.values()) {
      if (e.personId === personId && this.stateOf(e) === "pending") {
        e.revokedAt = this.iso();
      }
    }
    this.persist();
    return n;
  }

  // ── enrollment codes ───────────────────────────────────────────────────────────────────

  stateOf(e: Enrollment): EnrollmentState {
    if (e.revokedAt) {
      return "revoked";
    }
    if (e.usedAt) {
      return "used";
    }
    return Date.parse(e.expiresAt) <= this.now().getTime() ? "expired" : "pending";
  }

  listEnrollments(personId?: string): Enrollment[] {
    this.load();
    return [...this.enrollments.values()]
      .filter((e) => !personId || e.personId === personId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Issue a one-time enrollment code; only its hash is kept. The code is shown once. */
  issueEnrollment(
    personId: string,
    by: string,
    ttlMs: number,
  ): { code: string; enrollment: Enrollment } {
    this.load();
    const pending = this.listEnrollments(personId).filter((e) => this.stateOf(e) === "pending");
    if (pending.length >= MAX_PENDING_ENROLLMENTS_PER_PERSON) {
      throw new IdentityError(
        "limit",
        `at most ${MAX_PENDING_ENROLLMENTS_PER_PERSON} open enrollment codes per person: revoke one first`,
      );
    }
    if (this.enrollments.size >= MAX_ENROLLMENTS) {
      throw new IdentityError("limit", "too many enrollment codes");
    }
    const code = `${ENROLLMENT_CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
    const now = this.now().getTime();
    const enrollment: Enrollment = {
      id: randomUUID(),
      personId,
      codeHash: sha256hex(code),
      createdAt: new Date(now).toISOString(),
      createdBy: by,
      expiresAt: new Date(now + ttlMs).toISOString(),
      usedAt: null,
      usedFor: null,
      revokedAt: null,
    };
    this.enrollments.set(enrollment.id, enrollment);
    this.persist();
    return { code, enrollment };
  }

  /** The enrollment a presented code names (whatever its state), or null. */
  findEnrollmentByCode(code: string): Enrollment | null {
    this.load();
    if (!code.startsWith(ENROLLMENT_CODE_PREFIX) || code.length > 64) {
      return null;
    }
    const hash = Buffer.from(sha256hex(code));
    for (const e of this.enrollments.values()) {
      if (timingSafeEqual(Buffer.from(e.codeHash), hash)) {
        return e;
      }
    }
    return null;
  }

  getEnrollment(id: string): Enrollment | null {
    this.load();
    return this.enrollments.get(id) ?? null;
  }

  /** Spend a pending code (once). False when it is no longer pending. */
  consumeEnrollment(id: string, usedFor: string): boolean {
    this.load();
    const e = this.enrollments.get(id);
    if (!e || this.stateOf(e) !== "pending") {
      return false;
    }
    e.usedAt = this.iso();
    e.usedFor = usedFor;
    this.persist();
    return true;
  }

  revokeEnrollment(id: string): Enrollment {
    this.load();
    const e = this.enrollments.get(id);
    if (!e) {
      throw new IdentityError("not_found", "enrollment not found");
    }
    if (!e.revokedAt && !e.usedAt) {
      e.revokedAt = this.iso();
      this.persist();
    }
    return e;
  }
}
