import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { AppViewState } from "../app-view-state";
import { routineReasonMinimum } from "../controllers/autopilot";
import { localized } from "../controllers/projects";
import { t, type MessageId } from "../i18n";
import { renderAutopilotBrief } from "./autopilot-brief";

type State = Pick<
  AppViewState,
  | "reportAutopilotError"
  | "setAutopilotReportReason"
  | "setAutopilotRoutineReason"
  | "changeAutopilotRoutine"
  | "autopilot"
  | "canDeclineAutonomy"
  | "setAutonomyDeclineReason"
  | "declineAutonomy"
  | "acceptAutonomy"
  | "connected"
  | "locale"
  | "refreshAutopilot"
  | "setAutopilotFilters"
  | "inspectAutopilotRun"
  | "closeAutopilotRun"
>;
const label = (key: string) => {
  const id = `autopilot.${key}` as MessageId;
  const translated = t(id);
  return translated === id ? key : translated;
};
export function renderAutopilot(state: State, project: { id: string }) {
  const a = state.autopilot;
  const present = a.projectId === project.id;
  const filters = present ? a.filters : {};
  const editions = ["industrial", "business", "scholars", "core"] as const;
  const areas = [
    ...new Set([
      ...(present
        ? (a.routines?.routines
            .filter((routine) => !filters.edition || routine.edition === filters.edition)
            .map((routine) => routine.area) ?? [])
        : []),
      ...(filters.area ? [filters.area] : []),
    ]),
  ].toSorted();
  const visibleRoutines =
    a.routines?.routines.filter(
      (routine) =>
        (!filters.edition || routine.edition === filters.edition) &&
        (!filters.area || routine.area === filters.area),
    ) ?? [];
  const dateTime = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return t("autopilot.unknown");
    }
    return new Intl.DateTimeFormat(state.locale, {
      dateStyle: "medium",
      timeStyle: "long",
    }).format(date);
  };
  const routineName = (id: string) => {
    const routine = a.routines?.routines.find((entry) => entry.id === id);
    return routine ? localized(routine.name, state.locale) || id : id;
  };
  const counters = (values: Record<string, number | null>) => html`<dl class="ent-grid">
    ${Object.entries(values).map(([key, value]) => html`<div><dt>${label(key)}</dt><dd>${value === null ? t("autopilot.unknown") : value}</dd></div>`)}
  </dl>`;
  const knownLabel = (key: string) =>
    [
      "L0",
      "L1",
      "L2",
      "L3",
      "industrial",
      "business",
      "scholars",
      "core",
      "prepare",
      "internal-reversible",
      "external",
      "never",
      "ok",
      "escalated",
      "no_input",
      "failed",
      "skipped",
    ].includes(key)
      ? label(key)
      : key;
  const percent = (value: number | null) =>
    value === null
      ? t("autopilot.unknown")
      : new Intl.NumberFormat(state.locale, { style: "percent", maximumFractionDigits: 1 }).format(
          value,
        );
  const proposals =
    a.autonomy?.proposals.filter((proposal) =>
      visibleRoutines.some((routine) => routine.id === proposal.routineId),
    ) ?? [];
  const autonomy = () => html`<section data-autonomy aria-label=${t("autopilot.autonomyTitle")}>
    <h3>${t("autopilot.autonomyTitle")}</h3>
    <p class="muted">${t("autopilot.autonomyGuidance")}</p>
    ${a.acceptStatus ? html`<p role="status">${t(`autopilot.${a.acceptStatus}`)}</p>` : nothing}
    ${a.declineStatus ? html`<p role="status">${t(`autopilot.${a.declineStatus}`)}</p>` : nothing}
    ${
      a.autonomyError
        ? html`<p role="status">${t("autopilot.autonomyError")}</p>`
        : a.autonomy
          ? html`
      <p>${t("autopilot.autonomyPolicy", {
        days: a.autonomy.policy.windowDays,
        promoteItems: a.autonomy.policy.minItemsToPromote,
        promoteRate: percent(a.autonomy.policy.promoteAtOrBelow),
        demoteItems: a.autonomy.policy.minItemsToDemote,
        demoteRate: percent(a.autonomy.policy.demoteAtOrAbove),
      })}</p>
      ${proposals.length === 0 ? html`<p>${t("autopilot.noProposals")}</p>` : nothing}
      ${proposals.map(
        (proposal) => html`<article class="card ent-card">
        <h4>${routineName(proposal.routineId)} · ${label(proposal.kind)}</h4>
        <p>${t("autopilot.currentLevel")}: ${knownLabel(proposal.current)} · ${t("autopilot.proposedLevel")}: ${knownLabel(proposal.proposed)}</p>
        <p>${t("autopilot.fileCeiling")}: ${knownLabel(proposal.fileLevel)}</p>
        ${proposal.acceptBlocker ? html`<p data-accept-blocker>${t(proposal.acceptBlocker === "above_file_level" ? "autopilot.aboveFileLevel" : "autopilot.noStandingApproval")}</p>` : nothing}
        <p>${label(proposal.reason)}</p>
        ${proposal.needsStandingApproval ? html`<p>${t("autopilot.standingRequired")}</p>` : nothing}
        <p>${t("autopilot.evidenceWindow")}: ${dateTime(proposal.evidence.from)} – ${dateTime(proposal.evidence.to)}</p>
        ${counters({
          runs: proposal.evidence.runs,
          failedRuns: proposal.evidence.failedRuns,
          workItems: proposal.evidence.workItems,
          correctedByPerson: proposal.evidence.corrected,
          escalated: proposal.evidence.escalated,
        })}
        <p>${t("autopilot.correctionRate")}: ${percent(proposal.evidence.correctionRate)}</p>
        ${
          proposal.declined
            ? html`<p>${t("autopilot.declinedBy", { by: proposal.declined.by, at: dateTime(proposal.declined.at) })}</p><p>${proposal.declined.reason}</p>`
            : proposal.kind !== "hold" && state.canDeclineAutonomy
              ? html`
          <form @submit=${(event: Event) => {
            event.preventDefault();
            void state.declineAutonomy(proposal.routineId);
          }}>
            <label>${t("autopilot.declineReason")}
              <textarea required minlength="4" maxlength="1000"
                .value=${live(a.declineReasons[proposal.routineId] ?? "")}
                ?disabled=${!state.connected || !!a.declinePending || !!a.acceptPending || !!a.routinePending || !!a.reportPending}
                @input=${(event: Event) => state.setAutonomyDeclineReason(proposal.routineId, (event.target as HTMLTextAreaElement).value)}></textarea>
            </label>
            <button class="btn" type="button" data-accept-proposal
              ?disabled=${!state.connected || !!a.acceptPending || !!a.declinePending || !!a.routinePending || !!a.reportPending || proposal.acceptBlocker !== null || (a.declineReasons[proposal.routineId] ?? "").trim().length < 4 || (a.declineReasons[proposal.routineId] ?? "").trim().length > 1000}
              @click=${() => void state.acceptAutonomy(proposal.routineId)}>${t(a.acceptPending === proposal.routineId ? "autopilot.accepting" : "autopilot.accept")}</button>
            <button class="btn" type="submit" ?disabled=${!state.connected || !!a.declinePending || !!a.acceptPending || !!a.routinePending || !!a.reportPending || (a.declineReasons[proposal.routineId] ?? "").trim().length < 4 || (a.declineReasons[proposal.routineId] ?? "").trim().length > 1000}>${t(a.declinePending === proposal.routineId ? "autopilot.declining" : "autopilot.decline")}</button>
          </form>`
              : nothing
        }
      </article>`,
      )}
    `
          : nothing
    }
  </section>`;
  const routineControls = (r: NonNullable<typeof a.routines>["routines"][number]) => {
    if (!state.canDeclineAutonomy) {
      return nothing;
    }
    if (r.state.paused && (a.routines?.control.stopped || a.routines?.control.emergencyStop)) {
      return html`<p>${t("autopilot.routineStopped")}</p>`;
    }
    const minimum = routineReasonMinimum(r.state.paused, r.state.pausedBy);
    const reason = a.routineReasons[r.id] ?? "";
    const pending =
      !!a.declinePending || !!a.acceptPending || !!a.routinePending || !!a.reportPending;
    return html`<form @submit=${(event: Event) => {
      event.preventDefault();
      void state.changeAutopilotRoutine(r.id, r.state.paused ? "resume" : "pause");
    }}>
      <label>${t(minimum === 4 ? "autopilot.resumeReasonRequired" : minimum === 1 ? "autopilot.pauseReason" : "autopilot.resumeReason")}
        <textarea maxlength="1000" minlength=${minimum} ?required=${minimum > 0}
          .value=${live(reason)} ?disabled=${!state.connected || pending}
          @input=${(event: Event) => state.setAutopilotRoutineReason(r.id, (event.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <button class="btn" type="submit" ?disabled=${!state.connected || pending || reason.trim().length < minimum || reason.trim().length > 1000}>${t(a.routinePending === r.id ? "autopilot.routineSaving" : r.state.paused ? "autopilot.resumeRoutine" : "autopilot.pauseRoutine")}</button>
    </form>`;
  };
  const reportControl = (itemId: string) => {
    if (!state.canDeclineAutonomy) {
      return nothing;
    }
    const reason = a.reportReasons[itemId] ?? "";
    const pending =
      !!a.reportPending || !!a.routinePending || !!a.acceptPending || !!a.declinePending;
    return html`<form data-report-error @submit=${(event: Event) => {
      event.preventDefault();
      void state.reportAutopilotError(itemId);
    }}>
      <p>${t("autopilot.reportGuidance")}</p>
      <label>${t("autopilot.reportReason")}
        <textarea required minlength="4" maxlength="1000" .value=${live(reason)}
          ?disabled=${!state.connected || pending}
          @input=${(event: Event) => state.setAutopilotReportReason(itemId, (event.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <button class="btn" type="submit" ?disabled=${!state.connected || pending || reason.trim().length < 4 || reason.trim().length > 1000}>${t(a.reportPending === itemId ? "autopilot.reporting" : "autopilot.reportError")}</button>
    </form>`;
  };
  const detail = a.runDetail;
  const retained = detail?.evidence.tombstone === true;
  const evidencePassed = detail?.evidence.ok === true && detail.evidence.problems.length === 0;
  const limited = (values: unknown[]) =>
    values.length > 50 ? html`<p class="muted">${t("autopilot.detailLimit")}</p>` : nothing;
  const runDetails =
    () => html`<section id="autopilot-run-details" tabindex="-1" aria-label=${t("autopilot.runDetails")} class="card ent-card">
    <div class="ent-toolbar"><h3>${t("autopilot.runDetails")}</h3>
      <button class="btn" @click=${() => state.closeAutopilotRun()}>${t("autopilot.closeDetails")}</button></div>
    <p class="mono">${a.selectedRunId}</p>
    ${
      a.runLoading
        ? html`<p role="status">${t("autopilot.detailLoading")}</p>`
        : a.runError
          ? html`<p role="alert">${t("autopilot.detailError")}</p>
        <button class="btn" @click=${() => state.inspectAutopilotRun(a.selectedRunId!)}>${t("autopilot.retryDetails")}</button>`
          : detail
            ? html`
        <p>${routineName(detail.run.routineId)} · ${knownLabel(detail.run.status)}</p>
        <p>${t("autopilot.started")}: ${dateTime(detail.run.startedAt)}</p>
        <p>${t("autopilot.ended")}: ${dateTime(detail.run.endedAt)}</p>
        ${detail.run.reason ? html`<p>${detail.run.reason}</p>` : nothing}
        <h4>${t("autopilot.evidence")}</h4>
        <p role="status">${t(evidencePassed ? (retained ? "autopilot.evidenceRetained" : "autopilot.evidencePassed") : "autopilot.evidenceUnverified")}</p>
        ${retained ? nothing : html`<ul>${detail.evidence.problems.slice(0, 50).map((problem) => html`<li>${problem}</li>`)}</ul>${limited(detail.evidence.problems)}`}
        ${
          retained
            ? nothing
            : detail.run.evidence
              ? html`<p>${t("autopilot.evidenceRecorded")}</p>`
              : html`<p>${t("autopilot.noEvidenceBundle")}</p>`
        }
        <h4>${t("autopilot.workItems")}</h4>
        ${detail.run.workItems.slice(0, 50).map((itemId) => html`<article><p class="mono">${itemId}</p>${reportControl(itemId)}</article>`)}
        ${limited(detail.run.workItems)}
        <h4>${t("autopilot.gather")}</h4>
        ${detail.run.gather.length === 0 ? html`<p>${t("autopilot.none")}</p>` : nothing}
        ${detail.run.gather.slice(0, 50).map(
          (entry) => html`<article>
          <p>${entry.id} · ${entry.tool} · ${t("autopilot.calls")}: ${entry.calls} · ${t("autopilot.bytes")}: ${entry.bytes}</p>
          ${entry.error ? html`<p>${t("autopilot.failed")}: ${entry.error}</p>` : nothing}
        </article>`,
        )}${limited(detail.run.gather)}
        <h4>${t("autopilot.actions")}</h4>
        ${detail.run.actions.length === 0 ? html`<p>${t("autopilot.none")}</p>` : nothing}
        ${detail.run.actions.slice(0, 50).map(
          (action) => html`<article>
          <p>${action.item} · ${action.kind} · ${action.class ? knownLabel(action.class) : t("autopilot.unknown")}</p>
          <p>${t("autopilot.decision")}: ${label(action.decision)} · ${t(action.executed ? "autopilot.executed" : "autopilot.notExecuted")}</p>
          ${action.error ? html`<p>${t("autopilot.failed")}: ${action.error}</p>` : nothing}
          ${action.code ? html`<p>${t("autopilot.code")}: ${action.code}</p>` : nothing}
          ${action.ref ? html`<p>${t("autopilot.reference")}: ${action.ref}</p>` : nothing}
        </article>`,
        )}${limited(detail.run.actions)}
      `
            : nothing
    }
  </section>`;
  return html`<section class="card ent-card ent-card--wide" style="overflow-wrap: anywhere; min-width: 0" aria-label=${t("autopilot.title")}>
    <div class="ent-toolbar"><h2>${t("autopilot.title")}</h2>
      <button class="btn" ?disabled=${!state.connected || a.loading} @click=${() => state.refreshAutopilot()}>${t("autopilot.refresh")}</button></div>
    <p class="muted">${t("autopilot.readOnly")}</p>
    ${a.mutationDelayed ? html`<p role="status">${t("autopilot.mutationDelayed")}</p>` : nothing}
    ${present && a.reportStatus ? html`<p role="status">${t(`autopilot.${a.reportStatus}`)}</p>` : nothing}
    ${renderAutopilotBrief(a, project.id, state.connected, state.locale)}
    <div class="ent-toolbar">
      <label>${t("autopilot.editionFilter")}
        <select aria-label=${t("autopilot.editionFilter")} ?disabled=${!state.connected || !present}
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            void state.setAutopilotFilters({
              edition: editions.find((edition) => edition === value),
            });
          }}>
          <option value="" .selected=${live(!filters.edition)}>${t("autopilot.allEditions")}</option>
          ${editions.map((edition) => html`<option value=${edition} .selected=${live(filters.edition === edition)}>${label(edition)}</option>`)}
        </select>
      </label>
      <label>${t("autopilot.areaFilter")}
        <select aria-label=${t("autopilot.areaFilter")} ?disabled=${!state.connected || !present}
          @change=${(event: Event) => void state.setAutopilotFilters({ ...filters, area: (event.target as HTMLSelectElement).value || undefined })}>
          <option value="" .selected=${live(!filters.area)}>${t("autopilot.allAreas")}</option>
          ${areas.map((area) => html`<option value=${area} .selected=${live(filters.area === area)}>${area}</option>`)}
        </select>
      </label>
    </div>
    <p class="muted">${t("autopilot.filterScope")}</p>
    ${
      !state.connected
        ? html`<p role="status">${t("autopilot.offline")}</p>`
        : !present || a.loading
          ? html`<p role="status">${t("autopilot.loading")}</p>`
          : a.error
            ? html`<p role="alert">${t("autopilot.error")}</p>`
            : !a.routines
              ? nothing
              : html`
        ${
          a.routines.error
            ? html`<p role="alert">${t("autopilot.invalid")} ${a.routines.error}</p>`
            : a.routines.source.kind === "none"
              ? html`<p>${t("autopilot.missing")}</p>`
              : html`
          <h3>${t("autopilot.routines")}</h3>
          ${a.routineStatus ? html`<p role="status">${t(`autopilot.${a.routineStatus}`)}</p>` : nothing}
          ${visibleRoutines.length === 0 ? html`<p>${t(a.routines.routines.length === 0 ? "autopilot.empty" : "autopilot.noMatchingRoutines")}</p>` : nothing}
          ${visibleRoutines.map(
            (r) => html`<article class="card ent-card" data-routine-id=${r.id}>
            <h4>${localized(r.name, state.locale) || r.id} · ${knownLabel(r.effectiveLevel)}</h4>
            <p data-autonomy-levels>${t("autopilot.effectiveLevel")}: ${knownLabel(r.effectiveLevel)} · ${t("autopilot.fileCeiling")}: ${knownLabel(r.level)}</p>
            ${
              r.override
                ? html`<div data-level-override>
              <p>${t(r.override.kind === "accepted" ? "autopilot.acceptedOverride" : "autopilot.demotedOverride", { by: r.override.by, at: dateTime(r.override.at) })}</p>
              <p>${r.override.reason}</p>
            </div>`
                : nothing
            }
            ${
              r.lastDemotion
                ? html`<div data-last-demotion>
              <p>${t("autopilot.lastDemotion")}: ${knownLabel(r.lastDemotion.from)} → ${knownLabel(r.lastDemotion.to)} · ${dateTime(r.lastDemotion.at)}</p>
              <p>${t(r.lastDemotion.cause === "watchdog" ? "autopilot.watchdogDemotion" : "autopilot.reportedDemotion", { by: r.lastDemotion.by })}</p>
              <p>${r.lastDemotion.reason}</p>
            </div>`
                : nothing
            }
            <p>${knownLabel(r.edition)} / ${r.area} ${r.department ? html`· ${r.department}` : nothing}</p>
            <p>${label(r.enabled ? "enabled" : "disabled")} · ${label(r.state.paused ? "paused" : "unpaused")} · ${label(r.state.cronJobId ? "scheduled" : "unscheduled")}</p>
            ${routineControls(r)}
            ${r.state.pauseReason ? html`<p>${r.state.pauseReason}</p>` : nothing}
            <p class="mono">${r.trigger.kind === "schedule" ? `${r.trigger.expr} (${r.trigger.tz})` : r.trigger.kind === "interval" ? `${r.trigger.minutes} min` : r.trigger.tz}</p>
            ${(r.state.triggers ?? []).map((tr) => html`<p class="mono">${tr.source} · ${tr.status}${tr.lastError ? ` (${tr.lastError})` : ""}${tr.lastSignalAt ? ` · ${dateTime(tr.lastSignalAt)}` : ""}</p>`)}
            <p>${t("autopilot.actions")}: ${r.actions.length ? r.actions.map((action) => html`<span>${localized(action.label, state.locale) || action.id} (${knownLabel(action.class)}) </span>`) : t("autopilot.none")}</p>
            ${r.state.lastRunAt ? html`<p>${dateTime(r.state.lastRunAt)} · ${r.state.lastStatus ? knownLabel(r.state.lastStatus) : t("autopilot.unknown")}</p>` : nothing}
          </article>`,
          )}
        `
        }
        ${autonomy()}
        ${a.stats ? html`<h3>${t("autopilot.totals")}</h3>${counters(a.stats.totals)}` : nothing}
        ${
          a.runs
            ? html`<h3>${t(a.cursor ? "autopilot.history" : "autopilot.recent")}</h3>
          <p>${t(a.cursor ? "autopilot.pageShowing" : "autopilot.showing", { shown: a.runs.runs.length, total: a.runs.total })}</p>
          <div class="ent-toolbar">
            ${a.cursor ? html`<button class="btn" @click=${() => state.refreshAutopilot()}>${t("autopilot.latest")}</button>` : nothing}
            ${a.runs.nextCursor && a.runs.nextCursor !== a.cursor ? html`<button class="btn" @click=${() => state.refreshAutopilot(a.runs!.nextCursor!)}>${t("autopilot.older")}</button>` : nothing}
          </div>
          ${!a.runs.runs.length ? html`<p>${t("autopilot.noRuns")}</p>` : nothing}
          ${a.selectedRunId ? runDetails() : nothing}
          ${a.runs.runs.map(
            (run) => html`<article class="card ent-card">
            <h4>${routineName(run.routineId)} · ${knownLabel(run.status)} · ${knownLabel(run.level)}</h4>
            <p>${knownLabel(run.edition)} / ${run.area} · ${dateTime(run.startedAt)}</p>
            ${run.reason ? html`<p>${run.reason}</p>` : nothing}
            ${counters(run.counts)}
            <button class="btn" aria-expanded=${a.selectedRunId === run.id} aria-controls=${a.selectedRunId === run.id ? "autopilot-run-details" : nothing} @click=${() => state.inspectAutopilotRun(run.id)}>${t("autopilot.inspectRun")}</button>
          </article>`,
          )}
        `
            : nothing
        }
      `
    }
  </section>`;
}
