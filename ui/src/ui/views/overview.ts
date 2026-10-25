import { html } from "lit";
import type { GatewayHelloOk } from "../gateway";
import type { SsoConfig, SsoProvider, WhoAmI } from "../sso";
import type { UiSettings } from "../storage";
import { formatAgo, formatDurationMs } from "../format";
import { formatNextRun } from "../presenter";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  health: Record<string, unknown> | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  /** Organisation sign-in (shown only when the gateway has SSO providers or a person session). */
  sso?: SsoConfig | null;
  identity?: WhoAmI | null;
  onSsoSignIn?: (provider: SsoProvider) => void;
  onSsoSignOut?: () => void;
};

function renderSignIn(props: OverviewProps) {
  const me = props.identity?.kind === "person" ? props.identity : null;
  const providers = props.sso?.enabled ? props.sso.providers : [];
  if (!me && providers.length === 0) {
    return "";
  }
  if (me) {
    const who = me.person?.displayName ?? me.person?.email ?? me.principal;
    const roles = [...new Set(me.roles.map((r) => (r.unit ? `${r.role} (${r.unit})` : r.role)))];
    const until = me.session ? new Date(me.session.expiresAt).toLocaleString() : "n/a";
    return html`
      <div class="callout" style="margin-top: 14px;" data-testid="sso-session">
        <div>Signed in as <strong>${who}</strong>${me.person?.email && me.person.email !== who ? html` (${me.person.email})` : ""}</div>
        <div class="muted">Roles: ${roles.join(", ") || "none"} · Session until ${until}</div>
        <div class="row" style="margin-top: 8px;">
          <button class="btn" @click=${() => props.onSsoSignOut?.()}>Sign out</button>
        </div>
      </div>
    `;
  }
  return html`
    <div class="row" style="margin-top: 14px; flex-wrap: wrap;" data-testid="sso-login">
      ${providers.map(
        (p) => html`<button class="btn primary" @click=${() => props.onSsoSignIn?.(p)}>
          Sign in with ${p.label}
        </button>`,
      )}
      <span class="muted">
        ${props.sso?.required ? "Organisation sign-in is required." : "Or connect with a gateway token below."}
      </span>
    </div>
  `;
}

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number } }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs ? `${snapshot.policy.tickIntervalMs}ms` : "n/a";
  const authHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) {
      return null;
    }
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted" style="margin-top: 8px">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px">
            <span class="mono">kurahi dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">kurahi doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.kodasoken.com/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">kurahi dashboard --no-open</span>, or update the token, then click Connect.
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.kodasoken.com/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();
  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    if (!lower.includes("secure context") && !lower.includes("device identity required")) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or open
        <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.kodasoken.com/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.kodasoken.com/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  return html`
    <section class="mc-hero">
      <div class="mc-hero-head">
        <div>
          <div class="mc-eyebrow">Kurahi Gateway</div>
          <div class="mc-title">Mission Control</div>
        </div>
        <div class="mc-health ${props.connected ? "ok" : "warn"}">
          <span class="d"></span>${props.connected ? "Connected" : "Offline"}
        </div>
      </div>
      <div class="mc-stats">
        <div class="mc-stat">
          <div class="v ${props.connected ? "ok" : "warn"}">${props.connected ? "Live" : "Idle"}</div>
          <div class="l">Gateway status</div>
        </div>
        <div class="mc-stat"><div class="v">${uptime}</div><div class="l">Uptime</div></div>
        <div class="mc-stat">
          <div class="v">${props.sessionsCount ?? "—"}</div>
          <div class="l">Active sessions</div>
        </div>
        <div class="mc-stat"><div class="v">${props.presenceCount}</div><div class="l">Instances</div></div>
      </div>
    </section>

    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Gateway Access</div>
        <div class="card-sub">Where the dashboard connects and how it authenticates.</div>
        ${renderSignIn(props)}
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder="Paste the gateway token"
            />
          </label>
          <label class="field">
            <span>Password (not stored)</span>
            <input
              type="password"
              .value=${props.password}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onPasswordChange(v);
              }}
              placeholder="system or shared password"
            />
          </label>
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>Connect</button>
          <button class="btn" @click=${() => props.onRefresh()}>Refresh</button>
          <span class="muted">Click Connect to apply connection changes.</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Snapshot</div>
        <div class="card-sub">Latest gateway handshake information.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Status</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected ? "Connected" : "Disconnected"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Tick Interval</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Last Channels Refresh</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatAgo(props.lastChannelsRefresh) : "n/a"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Cron</div>
            <div class="stat-value">
              ${
                props.cronEnabled == null
                  ? "n/a"
                  : props.cronEnabled
                    ? html`On <span class="muted" style="font-size:13px;font-weight:500">· ${formatNextRun(props.cronNext)}</span>`
                    : "Disabled"
              }
            </div>
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
            : html`
                <div class="callout" style="margin-top: 14px">
                  Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.
                </div>
              `
        }
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Notes</div>
      <div class="card-sub">Quick reminders for remote control setups.</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">Tailscale serve</div>
          <div class="muted">
            Prefer serve mode to keep the gateway on loopback with tailnet auth.
          </div>
        </div>
        <div>
          <div class="note-title">Session hygiene</div>
          <div class="muted">Use /new or sessions.patch to reset context.</div>
        </div>
        <div>
          <div class="note-title">Cron reminders</div>
          <div class="muted">Use isolated sessions for recurring runs.</div>
        </div>
      </div>
    </section>
  `;
}
