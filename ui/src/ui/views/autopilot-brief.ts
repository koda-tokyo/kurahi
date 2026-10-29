import { html, nothing } from "lit";
import type { AutopilotState } from "../controllers/autopilot";
import { t } from "../i18n";

// Only classify known engine messages. Exception suffixes can contain secrets and paths.
function runReason(reason: string | null) {
  if (!reason) {
    return t("autopilot.briefReasonMissing");
  }
  const categories = [
    ["gather failed:", "autopilot.briefReasonGather"],
    ["knowledge failed:", "autopilot.briefReasonKnowledge"],
    ["brief plan failed:", "autopilot.briefReasonPlan"],
    ["work item intake failed:", "autopilot.briefReasonIntake"],
    ["watchdog escalation failed:", "autopilot.briefReasonEscalation"],
    ["watchdog:", "autopilot.briefReasonWatchdog"],
    ["kill switch:", "autopilot.briefReasonStopped"],
    ["emergency_stop:", "autopilot.briefReasonStopped"],
    ["stopped_all:", "autopilot.briefReasonStopped"],
  ] as const;
  return t(
    categories.find(([prefix]) => reason.startsWith(prefix))?.[1] ?? "autopilot.briefReasonPrivate",
  );
}

/** Briefs are caller-scoped snapshots, independent of the run-history filters. */
export function renderAutopilotBrief(
  state: AutopilotState,
  projectId: string,
  connected: boolean,
  locale: string,
  now = Date.now(),
) {
  const present = state.projectId === projectId;
  const brief = present && state.brief?.projectId === projectId ? state.brief : null;
  const date = (value: string) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          timestamp,
        )
      : t("autopilot.unknown");
  };
  const items = (
    entries: {
      itemId: string;
      title: string;
      queue: string;
      dueAt: string | null;
      overdue: boolean;
      flags?: string[];
    }[],
    truncated?: boolean,
  ) => html`
    ${entries.length === 0 ? html`<p>${t("autopilot.none")}</p>` : nothing}
    <ul>${entries.slice(0, 50).map(
      (item) => html`<li>
      ${item.title} · ${item.queue} · <span class="mono">${item.itemId}</span>
      ${item.dueAt ? html` · ${date(item.dueAt)}` : nothing}
      ${item.overdue ? html` · ${t("autopilot.briefOverdue")}` : nothing}
      ${item.flags ? html`<div data-brief-flags>${t("autopilot.briefFlags")}: ${item.flags.length ? html`<ul>${item.flags.slice(0, 10).map((flag) => html`<li>${flag.slice(0, 240)}${flag.length > 240 ? html`… (${t("autopilot.briefTextClipped")})` : nothing}</li>`)}</ul>` : t("autopilot.none")}${item.flags.length > 10 ? html`<p>${t("autopilot.briefFlagsLimit")}</p>` : nothing}</div>` : nothing}
    </li>`,
    )}</ul>${limit(entries, truncated)}`;
  const limit = (entries: unknown[], truncated?: boolean) =>
    truncated === true || entries.length > 50
      ? html`<p data-brief-limit>${t("autopilot.briefTruncated")}</p>`
      : truncated === undefined && entries.length >= 50
        ? html`<p data-brief-limit>${t("autopilot.briefLimit")}</p>`
        : nothing;
  const stale =
    brief &&
    (!Number.isFinite(Date.parse(brief.generatedAt)) ||
      now - Date.parse(brief.generatedAt) > 60 * 60 * 1000);
  return html`<section data-autopilot-brief style="overflow-wrap: anywhere; min-width: 0" aria-label=${t("autopilot.briefTitle")}>
    <h3>${t("autopilot.briefTitle")}</h3>
    <p class="muted">${t("autopilot.briefScope")}</p>
    ${
      !connected
        ? html`<p role="status">${t("autopilot.offline")}</p>`
        : !present || state.loading
          ? html`<p role="status">${t("autopilot.briefLoading")}</p>`
          : state.error || state.briefError || !brief
            ? html`<p role="status">${t("autopilot.briefError")}</p>`
            : html`
        <p>${t("autopilot.briefGenerated")}: ${date(brief.generatedAt)}</p>
        <p>${t("autopilot.evidenceWindow")}: ${date(brief.window.from)} – ${date(brief.window.to)}</p>
        ${stale ? html`<p role="status">${t("autopilot.briefStale")}</p>` : nothing}
        <h4>${t("autopilot.briefHandled")}</h4>
        <dl class="ent-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px">${(["runs", "items", "prepared", "acted", "escalated", "handled", "failedRuns"] as const).map((key) => html`<div><dt>${t(`autopilot.${key}`)}</dt><dd>${brief.handled[key]}</dd></div>`)}</dl>
        <p>${t("autopilot.briefDrafts")}: ${brief.handled.drafts}</p>
        <p class="muted">${t("autopilot.briefDraftScope")}</p>
        <h4>${t("autopilot.briefDocuments")}</h4>
        ${brief.documents.length === 0 ? html`<p>${t("autopilot.none")}</p>` : nothing}
        <ul>${brief.documents.slice(0, 50).map((document) => html`<li><span class="mono">${document.path}</span> · ${document.routineId} · ${date(document.at)}</li>`)}</ul>${limit(brief.documents, brief.truncated?.documents)}
        <h4>${t("autopilot.briefDecisions")}</h4>${items(brief.waiting.decisions, brief.truncated?.decisions)}
        <h4>${t("autopilot.briefFlagged")}</h4>${items(brief.waiting.flagged, brief.truncated?.flagged)}
        <h4>${t("autopilot.autonomyTitle")}</h4>
        ${brief.waiting.proposals.length === 0 ? html`<p>${t("autopilot.none")}</p>` : nothing}
        <ul>${brief.waiting.proposals.slice(0, 50).map(
          (proposal) => html`<li>${proposal.routineId} · ${proposal.current} → ${proposal.proposed}
          ${proposal.acceptBlocker ? html` · ${t(proposal.acceptBlocker === "above_file_level" ? "autopilot.aboveFileLevel" : "autopilot.noStandingApproval")}` : nothing}
        </li>`,
        )}</ul>${limit(brief.waiting.proposals)}
        <h4>${t("autopilot.briefCommitments")}</h4>${items(brief.commitments, brief.truncated?.commitments)}
        <section data-brief-linked-section>
        <h4>${t("autopilot.briefLinked")}</h4>
        ${!brief.waiting.linked ? html`<p role="status">${t("autopilot.briefLinkedUnavailable")}</p>` : brief.waiting.linked.length === 0 && !brief.truncated?.linked ? html`<p>${t("autopilot.none")}</p>` : nothing}
        <ul>${(brief.waiting.linked ?? []).slice(0, 50).map(
          (entry) => html`<li data-brief-linked>
          ${entry.title} · ${entry.queue} · <span class="mono">${entry.itemId}</span>
          ${entry.dueAt ? html` · ${date(entry.dueAt)}` : nothing}
          ${entry.overdue ? html` · ${t("autopilot.briefOverdue")}` : nothing}
          ${
            entry.unreadable
              ? html`<div>${t("autopilot.briefLinkedUnreadable")}</div>`
              : html`<div>${t("autopilot.briefLinkedProgress")}: ${entry.done}/${entry.total}</div>
          ${entry.ready.length ? html`<div>${t("autopilot.briefLinkedReady")}: ${entry.ready.join(", ")}</div>` : nothing}
          ${entry.missing.length ? html`<div>${t("autopilot.briefLinkedMissing")}: ${entry.missing.join(", ")}</div>` : nothing}
          ${entry.blocked ? html`<div>${t("autopilot.briefLinkedBlocked")}</div>` : nothing}`
          }
        </li>`,
        )}</ul>${brief.waiting.linked ? limit(brief.waiting.linked, brief.truncated?.linked) : nothing}
        </section>
        <section data-brief-notifications>
          <h4>${t("autopilot.briefNotifications")}</h4>
          ${
            !brief.waiting.notifications ||
            brief.waiting.notifications.unreadable ||
            !Number.isSafeInteger(brief.waiting.notifications.unread) ||
            brief.waiting.notifications.unread < 0
              ? html`<p role="status">${t("autopilot.briefNotificationsUnavailable")}</p>`
              : html`<p data-brief-notifications-count>${brief.waiting.notifications.unread}</p>`
          }
          <p class="muted">${t("autopilot.briefNotificationsScope")}</p>
        </section>
        <h4>${t("autopilot.briefProblems")}</h4>
        ${brief.problems.control.stopped || brief.problems.control.emergencyStop ? html`<p>${t("autopilot.routineStopped")}</p>` : nothing}
        ${brief.problems.routinesError ? html`<p>${t("autopilot.invalid")}</p>` : nothing}
        ${!brief.problems.control.stopped && !brief.problems.control.emergencyStop && !brief.problems.routinesError && !brief.problems.watchdog.length && !brief.problems.runs.length && !brief.problems.demotions.length && !brief.problems.paused.length ? html`<p>${t("autopilot.none")}</p>` : nothing}
        <ul>
          ${brief.problems.watchdog.slice(0, 50).map((entry) => html`<li>${t("autopilot.briefWatchdog")}: ${entry.routineId} · ${date(entry.at)}</li>`)}
          ${brief.problems.runs.slice(0, 50).map((entry) => html`<li>${entry.routineId} · ${t(`autopilot.${entry.status}`)} · ${date(entry.at)}<div data-brief-run-reason>${t("autopilot.briefReason")}: ${runReason(entry.reason)}</div></li>`)}
          ${brief.problems.demotions.slice(0, 50).map((entry) => html`<li>${t("autopilot.lastDemotion")}: ${entry.routineId} · ${entry.from} → ${entry.to} · ${date(entry.at)}</li>`)}
          ${brief.problems.paused.slice(0, 50).map((entry) => html`<li>${t("autopilot.paused")}: ${entry.routineId}</li>`)}
        </ul>
        ${[brief.problems.watchdog, brief.problems.runs, brief.problems.demotions, brief.problems.paused].map((entries) => limit(entries))}
      `
    }
  </section>`;
}
