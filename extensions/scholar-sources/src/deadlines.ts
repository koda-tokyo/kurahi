// scholar_grant_deadlines: the researcher's own deadline list (a Project file such as
// knowledge/grants.md, one `- YYYY-MM-DD | name | note` line per deadline) turned into reminders
// at fixed distances before each deadline. Deterministic: the date arithmetic is done here, not
// by a model. Each reminder has a stable id per deadline and distance, so a routine that fans out
// over the ids files each reminder once. Nothing is ever submitted anywhere.
import { createHash } from "node:crypto";

export const DEFAULT_REMIND_DAYS = [30, 14, 7, 3, 1];
const MAX_ENTRIES = 100;
const LINE_RE =
  /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s*[|｜]\s*([^|｜]{1,200}?)\s*(?:[|｜]\s*(.{0,300}?))?\s*$/;

export type GrantDeadline = { date: string; name: string; note: string };
export type GrantReminder = GrantDeadline & { id: string; daysLeft: number; bucket: number };

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

export function parseDeadlines(text: string): GrantDeadline[] {
  const out: GrantDeadline[] = [];
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) {
      continue;
    }
    const d = new Date(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) {
      continue;
    }
    out.push({
      date: m[1],
      name: m[2].replace(CONTROL_RE, " ").trim(),
      note: (m[3] ?? "").replace(CONTROL_RE, " ").trim(),
    });
    if (out.length >= MAX_ENTRIES) {
      break;
    }
  }
  return out;
}

/** YYYY-MM-DD of `now` in `tz`. */
export function dayIn(now: Date, tz: string): string {
  return now.toLocaleDateString("sv-SE", { timeZone: tz });
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length >= 3 ? s : createHash("sha256").update(name, "utf8").digest("hex").slice(0, 10);
}

/**
 * Reminders due today: a deadline `daysLeft` days away falls in the smallest distance that is at
 * least `daysLeft` (0 = due today). Past deadlines are not listed.
 */
export function dueReminders(
  entries: readonly GrantDeadline[],
  today: string,
  remindDays: readonly number[] = DEFAULT_REMIND_DAYS,
): GrantReminder[] {
  const t = Date.parse(`${today}T00:00:00Z`);
  const steps = [...new Set([0, ...remindDays])].toSorted((a, b) => a - b);
  const max = steps[steps.length - 1] ?? 0;
  const out: GrantReminder[] = [];
  for (const e of entries) {
    const daysLeft = Math.round((Date.parse(`${e.date}T00:00:00Z`) - t) / 86_400_000);
    if (daysLeft < 0 || daysLeft > max) {
      continue;
    }
    const bucket = steps.find((s) => s >= daysLeft) ?? max;
    out.push({ ...e, daysLeft, bucket, id: `grant:${slug(e.name)}:${e.date}:d${bucket}` });
  }
  return out.toSorted((a, b) => a.daysLeft - b.daysLeft);
}

export function formatReminders(
  list: readonly GrantReminder[],
  header: { path: string; today: string; tz: string },
): string {
  const lines = [
    `Grant deadlines from ${header.path} (today ${header.today}, ${header.tz}): ${list.length} reminder(s) due.`,
  ];
  for (const [i, r] of list.entries()) {
    lines.push(`${i + 1}. id: ${r.id}`);
    lines.push(`   grant: ${r.name}`);
    lines.push(
      `   deadline: ${r.date} (${r.daysLeft === 0 ? "due today" : `${r.daysLeft} day(s) left`}) · reminder: ${r.bucket === 0 ? "due date" : `${r.bucket} days before`}`,
    );
    if (r.note) {
      lines.push(`   note: ${r.note}`);
    }
  }
  return lines.join("\n");
}
