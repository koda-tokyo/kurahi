// `kurahi memory quarantine …` — operator review of memory writes held by the provenance guard
// (OWASP ASI06, src/memory/quarantine.ts). Agent tools are refused `approve|reject` by the core
// write policy (src/integrity/write-policy.ts).
import type { Command } from "commander";
import os from "node:os";
import { flushAudit } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import { resolveMemoryProvenanceMode } from "../memory/provenance.js";
import {
  approveQuarantined,
  listQuarantine,
  listQuarantineAgents,
  readQuarantineEntry,
  rejectQuarantined,
  type QuarantineEntry,
} from "../memory/quarantine.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { promptYesNo } from "./prompt.js";

type ListOpts = { agent?: string; status?: string; json?: boolean };
type DecideOpts = { agent?: string; yes?: boolean; json?: boolean; note?: string };

const STATUSES = new Set(["pending", "approved", "rejected", "all"]);

function operatorIdentity(): string {
  try {
    return `operator:${os.userInfo().username}`;
  } catch {
    return "operator";
  }
}

function fail(message: string, code = 1): never {
  defaultRuntime.error(`kurahi memory quarantine: ${message}`);
  return defaultRuntime.exit(code);
}

function preview(entry: QuarantineEntry, max = 160): string {
  const op = entry.op;
  const text = op.kind === "write" ? op.content : op.kind === "edit" ? op.newText : op.input;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function targetOf(entry: QuarantineEntry): string {
  const op = entry.op;
  return op.kind === "patch" ? op.paths.map(shortenHomePath).join(", ") : shortenHomePath(op.path);
}

/** The agent that holds `id`: the one given, or the only agent whose quarantine has it. */
function findAgentFor(id: string, agent?: string): string {
  if (agent) {
    return agent;
  }
  const owners = listQuarantineAgents().filter((a) => readQuarantineEntry(a, id));
  if (owners.length === 1) {
    return owners[0];
  }
  return fail(
    owners.length === 0 ? `no quarantined memory write ${id}` : `${id} is ambiguous; pass --agent`,
  );
}

export function runQuarantineList(opts: ListOpts) {
  const status = (opts.status ?? "pending").toLowerCase();
  if (!STATUSES.has(status)) {
    fail(`--status must be pending, approved, rejected or all (got ${opts.status})`);
  }
  const agents = opts.agent ? [opts.agent] : listQuarantineAgents();
  const entries = agents.flatMap((agentId) =>
    listQuarantine(agentId, { status: status as QuarantineEntry["status"] | "all" }).map(
      (entry) => ({ agentId, entry }),
    ),
  );
  if (opts.json) {
    defaultRuntime.log(JSON.stringify({ ok: true, status, entries }, null, 2));
    return;
  }
  let mode = "warn";
  try {
    mode = resolveMemoryProvenanceMode(loadConfig());
  } catch {}
  if (entries.length === 0) {
    defaultRuntime.log(
      `No ${status === "all" ? "" : `${status} `}quarantined memory writes (mode ${mode}).`,
    );
    return;
  }
  const lines: string[] = [];
  for (const { agentId, entry } of entries) {
    lines.push(
      `${entry.id}  ${entry.status}  agent=${agentId}  trust=${entry.provenance.trust}  ${entry.op.kind} ${targetOf(entry)}`,
    );
    lines.push(`  at ${entry.createdAt}  session=${entry.provenance.sessionKey ?? "-"}`);
    lines.push(`  why: ${entry.reasons.join("; ")}`);
    lines.push(`  text: ${preview(entry)}`);
  }
  lines.push("", "Review: kurahi memory quarantine show <id>; decide: approve <id> | reject <id>");
  defaultRuntime.log(lines.join("\n"));
}

export function runQuarantineShow(id: string, opts: { agent?: string; json?: boolean }) {
  const agentId = findAgentFor(id, opts.agent);
  const entry = readQuarantineEntry(agentId, id);
  if (!entry) {
    return fail(`no quarantined memory write ${id} for agent ${agentId}`);
  }
  if (opts.json) {
    defaultRuntime.log(JSON.stringify({ ok: true, agentId, entry }, null, 2));
    return;
  }
  const op = entry.op;
  const body =
    op.kind === "write"
      ? ["--- content ---", op.content]
      : op.kind === "edit"
        ? ["--- replace ---", op.oldText, "--- with ---", op.newText]
        : ["--- patch ---", op.input];
  defaultRuntime.log(
    [
      `${entry.id} (${entry.status}) agent=${agentId}`,
      `target: ${targetOf(entry)}`,
      `trust: ${entry.provenance.trust} (${entry.provenance.trustReasons.join("; ")})`,
      `tool: ${entry.provenance.tool}  session: ${entry.provenance.sessionKey ?? "-"}  job: ${entry.provenance.jobId ?? "-"}`,
      `why held: ${entry.reasons.join("; ")}`,
      ...body,
    ].join("\n"),
  );
}

async function decide(kind: "approve" | "reject", id: string, opts: DecideOpts) {
  const agentId = findAgentFor(id, opts.agent);
  if (kind === "approve" && !opts.yes) {
    if (!process.stdin.isTTY) {
      fail("not a terminal; pass --yes to approve");
    }
    const entry = readQuarantineEntry(agentId, id);
    const target = entry ? targetOf(entry) : id;
    if (!(await promptYesNo(`Write the held memory change to ${target}?`, false))) {
      fail("aborted");
    }
  }
  const run = kind === "approve" ? approveQuarantined : rejectQuarantined;
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run({ agentId, id, approver: operatorIdentity(), note: opts.note });
  } catch (err) {
    await flushAudit();
    return fail(err instanceof Error ? err.message : String(err));
  }
  await flushAudit();
  if (opts.json) {
    defaultRuntime.log(JSON.stringify({ ok: true, agentId, ...result }, null, 2));
    return;
  }
  defaultRuntime.log(
    kind === "approve"
      ? `Approved ${id}: written to ${result.written.map(shortenHomePath).join(", ")} (tagged approved, origin ${result.entry.provenance.trust}).`
      : `Rejected ${id}: not written.`,
  );
}

export function registerMemoryQuarantineCli(memory: Command) {
  const quarantine = memory
    .command("quarantine")
    .description("Review memory writes held for untrusted input (memory.provenance.mode)");

  quarantine
    .command("list")
    .description("List quarantined memory writes")
    .option("--agent <id>", "Agent id (default: every agent)")
    .option("--status <status>", "pending | approved | rejected | all", "pending")
    .option("--json", "Print JSON")
    .action((opts: ListOpts) => runQuarantineList(opts));

  quarantine
    .command("show")
    .description("Show one held write in full")
    .argument("<id>", "Quarantine id")
    .option("--agent <id>", "Agent id")
    .option("--json", "Print JSON")
    .action((id: string, opts: { agent?: string; json?: boolean }) => runQuarantineShow(id, opts));

  for (const kind of ["approve", "reject"] as const) {
    quarantine
      .command(kind)
      .description(
        kind === "approve"
          ? "Write the held change to active memory (tagged approved)"
          : "Discard the held change (kept for the audit trail)",
      )
      .argument("<id>", "Quarantine id")
      .option("--agent <id>", "Agent id")
      .option("--note <text>", "Reason recorded with the decision")
      .option("--yes", "Do not ask for confirmation", false)
      .option("--json", "Print JSON")
      .action(async (id: string, opts: DecideOpts) => {
        await decide(kind, id, opts);
      });
  }
}
