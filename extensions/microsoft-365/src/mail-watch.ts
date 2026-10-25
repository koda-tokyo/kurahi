// Microsoft 365 mail watcher for autopilot `m365.mail` event triggers (docs/autopilot.md#triggers).
//
// ONE watcher per connector sign-in (this plugin instance) polls Graph delta queries for every
// subscribed Project folder: `/me/mailFolders/{folder}/messages/delta?$select=id,receivedDateTime`.
// Only "new mail arrived" (a count) goes to the trigger dispatcher; ids, senders, subjects and
// bodies never leave this module, and the only thing stored (in the Project data dir) is the
// delta link. The first sync of a folder records the delta link without signalling (existing
// mail is not "new"); 410 Gone drops the link, re-syncs and signals once (a run then checks the
// folder itself); throttling backs off exponentially (the connector runtime already honours a
// short Retry-After); a sign-in that needs re-authentication marks the trigger degraded and is
// not retried until the stored sign-in changes (no spinning).
//
// Optional Graph change notifications (config notifications.publicUrl): a subscription per
// folder with a random clientState, renewed before expiry; a notification only makes the watcher
// poll that folder now (its content is not trusted or read). Polling stays on as the default and
// the fallback.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  MailSubscription,
  MailWatchProvider,
  ProviderHealth,
} from "../../../src/autopilot/triggers/mail-source.js";
import {
  type ConnectorRuntime,
  errorCodeOf,
  GRAPH_BASE,
  graphId,
  graphUrl,
  ConnectorError,
} from "../../../src/connectors/business/index.js";
import { CONNECTOR_ID, SCOPES } from "./config.js";

export const NOTIFICATIONS_PATH = "/plugins/microsoft-365/notifications";
/** Delta pages followed per poll (an initial sync of a large folder resumes on the next tick). */
const MAX_PAGES = 50;
const PAGE_SIZE = 200;
const MAX_BACKOFF_MS = 15 * 60_000;
/** Outlook message subscriptions live at most 4230 minutes; we ask for 2 days and renew. */
const SUBSCRIPTION_MS = 48 * 3_600_000;
const RENEW_BEFORE_MS = 6 * 3_600_000;
const WEBHOOK_RETRY_MS = 30 * 60_000;
const NOTIFY_BODY_MAX = 64 * 1024;
/** Sign-in problems a retry cannot fix: wait for a new sign-in. */
const NEEDS_PERSON = new Set([
  "reauth_required",
  "not_authenticated",
  "consent_required",
  "scope_missing",
  "not_configured",
]);

type DeltaPage = {
  value?: Array<{ id?: string; "@removed"?: unknown }>;
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

type Webhook = { id: string; clientState: string; expiresAt: number };

type Entry = {
  key: string;
  folder: string;
  subs: Set<MailSubscription>;
  /** The delta link store of the folder subscription (the first subscriber's). */
  store: MailSubscription["store"];
  busy: boolean;
  again: boolean;
  /** Initial sync in progress across ticks (never persisted). */
  resumeLink: string | null;
  resynced: boolean;
  failures: number;
  backoffUntil: number;
  /** Sign-in stamp when a sign-in problem was seen: retried only after it changes. */
  blockedOn: string | null;
  health: ProviderHealth;
  webhook: Webhook | null;
  webhookRetryAt: number;
};

export type MailWatcherOptions = {
  /** Poll interval, 30–600 s. */
  pollMs: number;
  /** Public https base URL that reaches this gateway (enables change notifications). */
  publicUrl?: string | null;
  now?: () => number;
  log?: { warn: (msg: string) => void };
};

export class M365MailWatcher {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runtime: ConnectorRuntime,
    private readonly opts: MailWatcherOptions,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private readonly inflight = new Set<Promise<void>>();

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Wait for the polls started by subscriptions and notifications (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all(this.inflight);
    }
  }

  provider(): MailWatchProvider {
    return { source: "m365.mail", connector: CONNECTOR_ID, subscribe: (s) => this.subscribe(s) };
  }

  subscribe(sub: MailSubscription): () => void {
    let e = this.entries.get(sub.key);
    if (!e) {
      e = {
        key: sub.key,
        folder: sub.folder,
        subs: new Set(),
        store: sub.store,
        busy: false,
        again: false,
        resumeLink: null,
        resynced: false,
        failures: 0,
        backoffUntil: 0,
        blockedOn: null,
        health: { status: "active", error: null },
        webhook: null,
        webhookRetryAt: 0,
      };
      this.entries.set(sub.key, e);
    }
    e.subs.add(sub);
    sub.onHealth(e.health);
    this.ensureTimer();
    this.track(this.pollKey(sub.key));
    return () => {
      const cur = this.entries.get(sub.key);
      if (!cur) {
        return;
      }
      cur.subs.delete(sub);
      if (cur.subs.size === 0) {
        this.entries.delete(sub.key);
        void this.deleteWebhook(cur);
      }
      if (this.entries.size === 0) {
        this.stopTimer();
      }
    };
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }
    const t = setInterval(() => this.track(this.pollAll()), this.opts.pollMs);
    t.unref?.();
    this.timer = t;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.stopTimer();
    for (const e of this.entries.values()) {
      void this.deleteWebhook(e);
    }
    this.entries.clear();
  }

  /** One tick: every folder in turn (sequential: one sign-in, one rate limiter). */
  async pollAll(): Promise<void> {
    // A snapshot: an unsubscribe during a poll must not skip or repeat a folder.
    for (const key of Array.from(this.entries.keys())) {
      await this.pollKey(key);
    }
  }

  private setHealth(e: Entry, health: ProviderHealth): void {
    if (e.health.status === health.status && e.health.error === health.error) {
      return;
    }
    e.health = health;
    for (const s of e.subs) {
      s.onHealth(health);
    }
  }

  private signStamp(): string {
    const t = this.runtime.tokens.load();
    return t ? `${t.obtainedAt}:${t.expiresAt}` : "none";
  }

  /** Poll one folder (a tick, a new subscription or a change notification). */
  async pollKey(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e) {
      return;
    }
    if (e.busy) {
      e.again = true;
      return;
    }
    e.busy = true;
    try {
      await this.pollEntry(e);
      if (this.opts.publicUrl) {
        await this.maintainWebhook(e);
      }
    } finally {
      e.busy = false;
    }
    if (e.again && this.entries.has(key)) {
      e.again = false;
      await this.pollKey(key);
    }
  }

  private async pollEntry(e: Entry): Promise<void> {
    const now = this.now();
    if (e.blockedOn !== null) {
      if (this.signStamp() === e.blockedOn) {
        return;
      }
      e.blockedOn = null;
      e.failures = 0;
      e.backoffUntil = 0;
    }
    if (e.backoffUntil > now) {
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.sync(e);
        e.failures = 0;
        e.backoffUntil = 0;
        this.setHealth(e, { status: "active", error: null });
        return;
      } catch (err) {
        if (err instanceof ConnectorError && err.status === 410 && attempt === 0) {
          // The delta token expired (410 Gone): forget it, sync afresh, signal once after.
          e.store.write(null);
          e.resumeLink = null;
          e.resynced = true;
          continue;
        }
        const code = errorCodeOf(err);
        if (NEEDS_PERSON.has(code)) {
          e.blockedOn = this.signStamp();
        } else {
          e.failures++;
          e.backoffUntil =
            now + Math.min(MAX_BACKOFF_MS, this.opts.pollMs * 2 ** Math.min(e.failures, 10));
        }
        this.setHealth(e, { status: "degraded", error: code });
        return;
      }
    }
  }

  private async sync(e: Entry): Promise<void> {
    const stored = e.store.read();
    const initial = stored === null;
    let url =
      e.resumeLink ??
      stored ??
      graphUrl(`/me/mailFolders/${graphId(e.folder, "folder")}/messages/delta`, {
        $select: "id,receivedDateTime",
      });
    let count = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (!url.startsWith(`${GRAPH_BASE}/`)) {
        // A stored or returned link must stay on Graph (the bearer token goes with it).
        e.store.write(null);
        e.resumeLink = null;
        throw new ConnectorError("invalid_response", "delta link is not a Graph URL");
      }
      const body = await this.runtime.json<DeltaPage>({
        url,
        scopes: [SCOPES.mail],
        headers: { prefer: `odata.maxpagesize=${PAGE_SIZE}` },
      });
      count += (body.value ?? []).filter((m) => m && !("@removed" in m)).length;
      if (typeof body["@odata.deltaLink"] === "string") {
        e.store.write(body["@odata.deltaLink"]);
        e.resumeLink = null;
        const resynced = e.resynced;
        e.resynced = false;
        if ((!initial && count > 0) || resynced) {
          for (const s of e.subs) {
            s.onNewMail(Math.max(count, 1));
          }
        }
        return;
      }
      if (typeof body["@odata.nextLink"] !== "string") {
        throw new ConnectorError("invalid_response", "delta page has no next or delta link");
      }
      url = body["@odata.nextLink"];
    }
    // Large initial sync: continue from here next tick (in memory only).
    if (initial) {
      e.resumeLink = url;
      return;
    }
    // A steady-state backlog this large: signal and keep paging next tick.
    e.resumeLink = url;
    for (const s of e.subs) {
      s.onNewMail(Math.max(count, 1));
    }
  }

  // ---- change notifications (optional) ----

  private notificationUrl(): string | null {
    const base = this.opts.publicUrl?.replace(/\/+$/, "");
    return base ? `${base}${NOTIFICATIONS_PATH}` : null;
  }

  private async maintainWebhook(e: Entry): Promise<void> {
    const url = this.notificationUrl();
    const now = this.now();
    if (!url || e.blockedOn !== null || now < e.webhookRetryAt) {
      return;
    }
    try {
      if (!e.webhook || e.webhook.expiresAt <= now) {
        const clientState = randomBytes(24).toString("base64url");
        const expiresAt = now + SUBSCRIPTION_MS;
        const res = await this.runtime.json<{ id?: string; expirationDateTime?: string }>({
          url: graphUrl("/subscriptions"),
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            changeType: "created",
            notificationUrl: url,
            resource: `me/mailFolders('${e.folder.replace(/'/g, "''")}')/messages`,
            expirationDateTime: new Date(expiresAt).toISOString(),
            clientState,
          }),
          scopes: [SCOPES.mail],
        });
        if (typeof res.id !== "string" || !res.id) {
          throw new ConnectorError("invalid_response", "subscription has no id");
        }
        const exp = Date.parse(res.expirationDateTime ?? "");
        e.webhook = { id: res.id, clientState, expiresAt: Number.isFinite(exp) ? exp : expiresAt };
      } else if (e.webhook.expiresAt - now < RENEW_BEFORE_MS) {
        const expiresAt = now + SUBSCRIPTION_MS;
        await this.runtime.request({
          url: graphUrl(`/subscriptions/${graphId(e.webhook.id, "subscription")}`),
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expirationDateTime: new Date(expiresAt).toISOString() }),
          scopes: [SCOPES.mail],
        });
        e.webhook.expiresAt = expiresAt;
      }
    } catch (err) {
      // Polling carries on; the subscription is retried later.
      e.webhook = null;
      e.webhookRetryAt = now + WEBHOOK_RETRY_MS;
      this.opts.log?.warn(`microsoft-365: change notifications unavailable (${errorCodeOf(err)})`);
    }
  }

  private async deleteWebhook(e: Entry): Promise<void> {
    const hook = e.webhook;
    e.webhook = null;
    if (!hook) {
      return;
    }
    try {
      await this.runtime.request({
        url: graphUrl(`/subscriptions/${graphId(hook.id, "subscription")}`),
        method: "DELETE",
        scopes: [SCOPES.mail],
      });
    } catch {
      // It expires on its own.
    }
  }

  /** Subscriptions currently held (tests and status). */
  webhookOf(key: string): Readonly<Webhook> | null {
    return this.entries.get(key)?.webhook ?? null;
  }

  /**
   * A Graph notification POST. The validation handshake echoes `validationToken` as text/plain;
   * a notification is accepted only for a known subscription id with its exact clientState, and
   * then only makes the watcher poll that folder (the notification content is not used).
   */
  handleNotification(req: { query: URLSearchParams; body: string }): {
    status: number;
    contentType: string;
    body: string;
    accepted: number;
  } {
    const token = req.query.get("validationToken");
    if (token !== null) {
      // Echo exactly, as plain text; refuse anything that is not a plausible token.
      if (token.length === 0 || token.length > 1024 || hasControlChar(token)) {
        return { status: 400, contentType: "text/plain", body: "", accepted: 0 };
      }
      return { status: 200, contentType: "text/plain; charset=utf-8", body: token, accepted: 0 };
    }
    let doc: { value?: Array<{ subscriptionId?: unknown; clientState?: unknown }> };
    try {
      doc = JSON.parse(req.body) as typeof doc;
    } catch {
      return { status: 400, contentType: "text/plain", body: "", accepted: 0 };
    }
    const keys = new Set<string>();
    for (const n of Array.isArray(doc?.value) ? doc.value.slice(0, 100) : []) {
      for (const e of this.entries.values()) {
        if (
          e.webhook &&
          n.subscriptionId === e.webhook.id &&
          typeof n.clientState === "string" &&
          safeEqual(n.clientState, e.webhook.clientState)
        ) {
          keys.add(e.key);
        }
      }
    }
    for (const key of keys) {
      this.track(this.pollKey(key));
    }
    return { status: 202, contentType: "text/plain", body: "", accepted: keys.size };
  }

  /** The HTTP route handler (plugin route, no gateway auth: the clientState is the check). */
  async httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    if (!url.searchParams.has("validationToken")) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += b.byteLength;
        if (total > NOTIFY_BODY_MAX) {
          res.statusCode = 413;
          res.end();
          return;
        }
        chunks.push(b);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const out = this.handleNotification({ query: url.searchParams, body });
    res.statusCode = out.status;
    res.setHeader("content-type", out.contentType);
    res.end(out.body);
  }
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return true;
    }
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.byteLength === y.byteLength && timingSafeEqual(x, y);
}
