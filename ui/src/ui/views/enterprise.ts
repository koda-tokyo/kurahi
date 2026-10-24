// v0.2 enterprise pages: Home, Approvals, Connectors, Policies & permissions, Audit log, Models,
// and the placeholder pages (Outputs, Evaluation, Help).
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import {
  approvalRules,
  auditCsv,
  auditRecordsFromLogs,
  credentialPolicy,
  defaultModelSelection,
  filterAuditRecords,
  modelProviderRows,
  todaysRuns,
  type AuditRecord,
  type ModelLocation,
} from "../controllers/enterprise";
import { formatAgo, formatDurationMs } from "../format";
import { t, type MessageId } from "../i18n";
import { icons } from "../icons";

function fmtTime(ms: number | null | undefined): string {
  if (!ms) {
    return "";
  }
  try {
    return new Date(ms).toLocaleString(document.documentElement.lang || undefined);
  } catch {
    return new Date(ms).toISOString();
  }
}

function decisionLabel(decision: string | null): string {
  switch (decision) {
    case "allow-once":
      return t("decision.allow-once");
    case "allow-always":
      return t("decision.allow-always");
    case "deny":
      return t("decision.deny");
    case "expired":
      return t("decision.expired");
    default:
      return t("decision.unknown");
  }
}

function card(title: MessageId, body: TemplateResult | typeof nothing, extra = "") {
  return html`<section class="card ent-card ${extra}">
    <div class="card-title">${t(title)}</div>
    ${body}
  </section>`;
}

function notConnected(state: AppViewState) {
  return state.connected
    ? nothing
    : html`<div class="callout ent-callout">${t("common.notConnected")}</div>`;
}

// ---- Home ----

export function renderHome(state: AppViewState) {
  const health = (state.debugHealth ?? {}) as Record<string, unknown>;
  const snapshot = state.hello?.snapshot as
    | { uptimeMs?: number; server?: { version?: string } }
    | undefined;
  const rawVersion =
    (state.hello as { server?: { version?: string } } | null)?.server?.version ||
    (typeof health.version === "string" ? health.version : "");
  // A gateway started outside a release build reports "dev"; that is not a version to show.
  const version = rawVersion && rawVersion !== "dev" ? rawVersion : "";
  const pending = state.execApprovalQueue.length;
  const today = todaysRuns(state.cronJobs);
  const agents = state.agentsList?.agents?.length ?? null;
  const recentSessions =
    state.sessionsResult?.sessions?.filter((s) => {
      const updated = (s as { updatedAt?: number }).updatedAt;
      return typeof updated === "number" && Date.now() - updated < 3_600_000;
    }).length ?? null;
  const statusKey: MessageId =
    state.serviceStatus === "running"
      ? "header.status.running"
      : state.serviceStatus === "attention"
        ? "header.status.attention"
        : "header.status.stopped";

  return html`
    ${notConnected(state)}
    <div class="ent-grid">
      ${card(
        "home.card.health",
        html`<div class="ent-big"><span class="ent-dot ent-dot--${state.serviceStatus}"></span>${t(statusKey)}</div>
          <div class="muted">
            ${version ? t("home.health.version", { version }) : nothing}
            ${snapshot?.uptimeMs ? html` · ${t("home.health.uptime", { duration: formatDurationMs(snapshot.uptimeMs) })}` : nothing}
          </div>`,
      )}
      ${card(
        "home.card.approvals",
        html`<div class="ent-big">${pending}</div>
          <div class="muted">${pending ? t("home.approvals.some", { count: pending }) : t("home.approvals.none")}</div>
          ${pending ? html`<button class="btn btn--sm" @click=${() => state.setTab("approvals")}>${t("common.open")}</button>` : nothing}`,
      )}
      ${card(
        "home.card.today",
        html`<div class="ent-big">${today.remaining}</div>
          <div class="muted">
            ${
              state.cronStatus && state.cronStatus.enabled === false
                ? t("home.today.disabled")
                : today.remaining
                  ? t("home.today.runs", { count: today.remaining })
                  : t("home.today.none")
            }
          </div>
          ${today.nextAtMs ? html`<div class="muted">${t("home.today.next", { time: fmtTime(today.nextAtMs) })}</div>` : nothing}`,
      )}
      ${card(
        "home.card.agents",
        html`<div class="ent-big">${agents ?? "–"}</div>
          <div class="muted">${agents != null ? t("home.agents.count", { count: agents }) : nothing}</div>
          ${recentSessions != null ? html`<div class="muted">${t("home.agents.sessions", { count: recentSessions })}</div>` : nothing}`,
      )}
    </div>
    ${card(
      "home.card.recent",
      state.enterprise.approvalHistory.length
        ? html`<ul class="ent-list">
            ${state.enterprise.approvalHistory.slice(0, 8).map(
              (h) => html`<li>
                <span class="chip ${h.decision === "deny" ? "chip-warn" : "chip-ok"}">${decisionLabel(h.decision)}</span>
                <span class="mono ent-trunc" title=${h.command}>${h.command || h.id}</span>
                <span class="muted">${h.agentId ?? ""} · ${formatAgo(h.ts)}</span>
              </li>`,
            )}
          </ul>`
        : html`<div class="muted">${t("home.recent.empty")}</div>`,
      "ent-card--wide",
    )}
  `;
}

// ---- Approvals ----

export function renderApprovals(state: AppViewState) {
  const queue = state.execApprovalQueue;
  return html`
    ${notConnected(state)}
    <div class="callout ent-callout">${t("approvals.liveOnly")}</div>
    ${state.execApprovalError ? html`<div class="callout danger">${state.execApprovalError}</div>` : nothing}
    <section class="card ent-card ent-card--wide">
      ${
        queue.length === 0
          ? html`<div class="ent-empty">${icons.shieldCheck}<span>${t("approvals.empty")}</span></div>`
          : html`<div class="ent-table-wrap"><table class="ent-table">
            <thead><tr>
              <th>${t("approvals.col.request")}</th>
              <th>${t("approvals.col.agent")}</th>
              <th>${t("approvals.col.requested")}</th>
              <th>${t("approvals.col.expires")}</th>
              <th>${t("approvals.col.decision")}</th>
            </tr></thead>
            <tbody>
              ${queue.map(
                (q, index) => html`<tr>
                  <td><span class="mono ent-wrap">${q.request.command}</span>
                    ${q.request.cwd ? html`<div class="muted mono">${q.request.cwd}</div>` : nothing}</td>
                  <td>${q.request.agentId ?? ""}</td>
                  <td>${fmtTime(q.createdAtMs)}</td>
                  <td>${fmtTime(q.expiresAtMs)}</td>
                  <td>
                    ${
                      index === 0
                        ? html`<div class="ent-actions">
                          <button class="btn btn--sm primary" ?disabled=${state.execApprovalBusy}
                            @click=${() => state.handleExecApprovalDecision("allow-once")}>${t("approvals.allowOnce")}</button>
                          <button class="btn btn--sm" ?disabled=${state.execApprovalBusy}
                            @click=${() => state.handleExecApprovalDecision("allow-always")}>${t("approvals.allowAlways")}</button>
                          <button class="btn btn--sm danger" ?disabled=${state.execApprovalBusy}
                            @click=${() => state.handleExecApprovalDecision("deny")}>${t("approvals.deny")}</button>
                        </div>`
                        : html`
                            <span class="muted">…</span>
                          `
                    }
                  </td>
                </tr>`,
              )}
            </tbody>
          </table></div>`
      }
    </section>
    ${
      state.enterprise.approvalHistory.length
        ? card(
            "approvals.history",
            html`<ul class="ent-list">
            ${state.enterprise.approvalHistory.map(
              (h) => html`<li>
                <span class="chip ${h.decision === "deny" ? "chip-warn" : "chip-ok"}">${decisionLabel(h.decision)}</span>
                <span class="mono ent-trunc" title=${h.command}>${h.command || h.id}</span>
                <span class="muted">${fmtTime(h.ts)}</span>
              </li>`,
            )}
          </ul>`,
            "ent-card--wide",
          )
        : nothing
    }
  `;
}

// ---- Policies & permissions ----

function configOf(state: AppViewState): Record<string, unknown> | null {
  return (state.configSnapshot?.config as Record<string, unknown> | undefined) ?? null;
}

export function renderPolicies(state: AppViewState) {
  const config = configOf(state);
  const policy = credentialPolicy(config);
  const rules = approvalRules(state.execApprovalsSnapshot?.file ?? null);
  const isolationText =
    policy.isolation === "explicit"
      ? t("policies.isolation.explicit")
      : policy.isolation === "inherit"
        ? t("policies.isolation.inherit")
        : t("policies.isolation.unset");
  return html`
    ${notConnected(state)}
    <div class="ent-toolbar">
      <button class="btn btn--sm" @click=${() => state.refreshEnterprise()}>${t("common.refresh")}</button>
      <span class="muted">${t("common.readOnly")}</span>
    </div>
    ${config ? nothing : html`<div class="callout">${t("policies.configMissing")}</div>`}
    ${card(
      "policies.isolation",
      html`<div><span class="mono">auth.isolation</span> = <strong>${policy.isolation ?? "–"}</strong></div>
        <div class="muted">${isolationText}</div>`,
      "ent-card--wide",
    )}
    ${card(
      "policies.grants",
      policy.grants.length
        ? html`<div class="ent-table-wrap"><table class="ent-table">
            <thead><tr><th>${t("policies.grants.agent")}</th><th>${t("policies.grants.profiles")}</th></tr></thead>
            <tbody>${policy.grants.map(
              (g) =>
                html`<tr><td class="mono">${g.agent}</td><td>${g.profiles.length ? g.profiles.map((p) => html`<span class="chip mono">${p}</span> `) : html`<span class="muted">${t("common.none")}</span>`}</td></tr>`,
            )}</tbody>
          </table></div>`
        : html`<div class="muted">${t("policies.grants.empty")}</div>`,
      "ent-card--wide",
    )}
    ${card(
      "policies.approvals",
      rules.length
        ? html`<div class="ent-table-wrap"><table class="ent-table">
            <thead><tr><th></th><th>${t("policies.approvals.security")}</th><th>${t("policies.approvals.ask")}</th><th></th></tr></thead>
            <tbody>${rules.map(
              (r) => html`<tr>
                <td>${r.scope === "*" ? t("policies.approvals.defaults") : t("policies.approvals.agent", { agent: r.scope })}</td>
                <td class="mono">${r.security || "–"}</td>
                <td class="mono">${r.ask || "–"}</td>
                <td class="muted">${r.allowlist ? t("policies.approvals.allowlist", { count: r.allowlist }) : ""}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
        : html`<div class="muted">${t("policies.approvals.empty")}</div>`,
      "ent-card--wide",
    )}
    ${card(
      "policies.engine",
      state.enterprise.policyStatus
        ? html`<pre class="code-block ent-pre">${JSON.stringify(state.enterprise.policyStatus, null, 2)}</pre>`
        : html`<div class="muted">${state.enterprise.policyError ?? t("policies.engine.empty")}</div>`,
      "ent-card--wide",
    )}
  `;
}

// ---- Audit log ----

function downloadCsv(rows: AuditRecord[]) {
  const blob = new Blob([auditCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kurahi-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderAudit(state: AppViewState) {
  const e = state.enterprise;
  const source = e.auditSource;
  const all = source === "logs" ? auditRecordsFromLogs(state.logsEntries) : (e.auditEvents ?? []);
  const rows = filterAuditRecords(all, e.auditQuery, source === "logs" ? e.auditLevel : "");
  const shown = rows.slice(-500).toReversed();
  return html`
    ${notConnected(state)}
    <div class="ent-toolbar">
      <div class="ent-seg" role="tablist">
        ${(["logs", "audit"] as const).map(
          (
            s,
          ) => html`<button role="tab" aria-selected=${s === source} class="ent-seg__btn ${s === source ? "active" : ""}"
            @click=${() => state.setAuditSource(s)}>${t(s === "logs" ? "audit.source.logs" : "audit.source.audit")}</button>`,
        )}
      </div>
      <label class="ent-search">
        <span class="sr-only">${t("common.search")}</span>
        ${icons.search}
        <input type="search" .value=${e.auditQuery} placeholder=${t("audit.searchPlaceholder")}
          @input=${(ev: Event) => state.patchEnterprise({ auditQuery: (ev.target as HTMLInputElement).value })} />
      </label>
      ${
        source === "logs"
          ? html`<select .value=${e.auditLevel} @change=${(ev: Event) => state.patchEnterprise({ auditLevel: (ev.target as HTMLSelectElement).value })}>
            <option value="">${t("audit.level.all")}</option>
            ${["fatal", "error", "warn", "info", "debug", "trace"].map((l) => html`<option value=${l}>${l}</option>`)}
          </select>`
          : nothing
      }
      <button class="btn btn--sm" @click=${() => state.refreshEnterprise()}>${t("common.refresh")}</button>
      <button class="btn btn--sm" ?disabled=${rows.length === 0} @click=${() => downloadCsv(rows)}>
        ${icons.download} ${t("common.exportCsv")}
      </button>
    </div>
    ${source === "audit" && e.auditError ? html`<div class="callout">${t("audit.unavailable", { reason: e.auditError })}</div>` : nothing}
    ${source === "logs" && state.logsError ? html`<div class="callout danger">${state.logsError}</div>` : nothing}
    <div class="muted ent-count">${t("audit.count", { shown: shown.length, total: all.length })}</div>
    <section class="card ent-card ent-card--wide">
      ${
        shown.length === 0
          ? html`<div class="ent-empty">${icons.clipboardList}<span>${t("audit.empty")}</span></div>`
          : html`<div class="ent-table-wrap"><table class="ent-table ent-table--dense">
            <thead><tr>
              <th>${t("audit.col.time")}</th>
              ${
                source === "logs"
                  ? html`<th>${t("audit.col.level")}</th><th>${t("audit.col.source")}</th><th>${t("audit.col.message")}</th>`
                  : html`<th>${t("audit.col.action")}</th><th>${t("audit.col.target")}</th><th>${t("audit.col.user")}</th>`
              }
            </tr></thead>
            <tbody>${shown.map(
              (r) => html`<tr>
                <td class="mono ent-nowrap">${r.time}</td>
                ${
                  source === "logs"
                    ? html`<td><span class="log-level ${r.level}">${r.level}</span></td><td class="mono">${r.source}</td><td class="ent-wrap">${r.message}</td>`
                    : html`<td class="mono">${r.action}</td><td class="mono">${r.target}</td><td>${r.user}</td>`
                }
              </tr>`,
            )}</tbody>
          </table></div>`
      }
    </section>
  `;
}

// ---- Models ----

function whereText(where: ModelLocation): string {
  if (where.kind === "local") {
    return t("models.where.local");
  }
  if (where.kind === "remote") {
    return t("models.where.remote", { host: where.host });
  }
  return t("models.where.unknown");
}

export function renderModels(state: AppViewState) {
  const config = configOf(state);
  const rows = modelProviderRows(config);
  const sel = defaultModelSelection(config);
  return html`
    ${notConnected(state)}
    <div class="ent-toolbar">
      <button class="btn btn--sm" @click=${() => state.refreshEnterprise()}>${t("common.refresh")}</button>
      <span class="muted">${t("common.readOnly")}</span>
    </div>
    ${config ? nothing : html`<div class="callout">${t("policies.configMissing")}</div>`}
    ${card(
      "models.default",
      html`<div class="mono">${sel.primary ?? "–"}</div>
        ${sel.fallbacks.length ? html`<div class="muted">${t("models.fallbacks")}: <span class="mono">${sel.fallbacks.join(", ")}</span></div>` : nothing}
        ${state.enterprise.modelsCatalogCount != null ? html`<div class="muted">${t("models.catalog", { count: state.enterprise.modelsCatalogCount })}</div>` : nothing}`,
      "ent-card--wide",
    )}
    <section class="card ent-card ent-card--wide">
      ${
        rows.length === 0
          ? html`<div class="ent-empty">${icons.cpu}<span>${t("models.empty")}</span></div>`
          : html`<div class="ent-table-wrap"><table class="ent-table">
            <thead><tr><th>${t("models.col.provider")}</th><th>${t("models.col.models")}</th><th>${t("models.col.where")}</th></tr></thead>
            <tbody>${rows.map(
              (r) => html`<tr>
                <td class="mono">${r.id}</td>
                <td>${r.models.length ? r.models.map((m) => html`<span class="chip mono">${m}</span> `) : html`<span class="muted">${t("common.none")}</span>`}</td>
                <td>${whereText(r.where)}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
      }
    </section>
  `;
}

// ---- placeholders ----

export function renderComingSoon(icon: keyof typeof icons) {
  return html`<section class="card ent-card ent-card--wide">
    <div class="ent-empty">${icons[icon]}<strong>${t("common.comingSoon")}</strong><span>${t("common.comingSoonBody")}</span></div>
  </section>`;
}

export function renderHelp() {
  return html`<section class="card ent-card ent-card--wide">
    <div class="ent-empty">${icons.helpCircle}<span>${t("help.body")}</span></div>
  </section>`;
}
