// Signed evidence for autopilot runs: one sealed bundle per run in the standard evidence format
// (events.jsonl hash chain + Ed25519-signed manifest.json, see src/evidence/store.ts), so
// `kolo evidence verify <dir>` and verifyEvidenceBundle() check it like any job bundle. Each
// bundle's job.start names the routine's previous run bundle root, chaining the routine's runs.
// Events hold ids, digests, decisions and counts; never mail bodies, addresses or file text.

import path from "node:path";
import type { EvidenceEventType } from "../evidence/types.js";
import type { RunRecord } from "./types.js";
import { type SealedEventBody, writeSealedBundle } from "../evidence/sealed-bundle.js";
import { runDir } from "./store.js";

export function runEvidenceDir(projectId: string, runId: string, home?: string): string {
  return path.join(runDir(projectId, runId, home), "evidence");
}

export function writeRunEvidence(
  record: RunRecord,
  prevRoot: string | null,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): { bundle: string; root: string } {
  const dir = runEvidenceDir(record.projectId, record.id, opts.home);
  const jobId = `ap-${record.id}`;
  const bodies: SealedEventBody[] = [
    {
      type: "job.start",
      ts: record.startedAt,
      data: {
        kind: "autopilot.run",
        projectId: record.projectId,
        routineId: record.routineId,
        edition: record.edition,
        area: record.area,
        level: record.level,
        trigger: record.trigger,
        triggeredBy: record.triggeredBy,
        ...(record.triggerSources ? { triggerSources: record.triggerSources } : {}),
        routineDigest: record.routineDigest,
        prevRoot,
      },
    },
    ...record.gather.map((g) => ({
      type: "tool.call" as const,
      ts: record.startedAt,
      data: { step: g.id, tool: g.tool, calls: g.calls, bytes: g.bytes, error: g.error },
    })),
    {
      type: "model.turn",
      ts: record.endedAt,
      data: {
        backend: record.reasoning.backend,
        model: record.reasoning.model,
        ms: record.reasoning.ms,
        outputSha256: record.reasoning.outputSha256,
        tools: "none",
      },
    },
    ...record.actions.map((a) => ({
      type: (a.approvalId ? "approval" : "permission") as EvidenceEventType,
      ts: record.endedAt,
      data: {
        item: a.item,
        action: a.kind,
        class: a.class,
        decision: a.decision,
        code: a.code,
        executed: a.executed,
        error: a.error,
        approvalId: a.approvalId,
        ref: a.ref,
      },
    })),
    // The behaviour watchdog's verdict when it tripped (nothing was executed).
    ...(record.watchdog?.tripped
      ? [
          {
            type: "loop_guard" as const,
            ts: record.endedAt,
            data: {
              guard: "autopilot.watchdog",
              reasons: record.watchdog.reasons,
              baseline: record.watchdog.baseline,
              metrics: record.watchdog.metrics,
            },
          },
        ]
      : []),
    {
      type: "audit",
      ts: record.endedAt,
      data: { counts: record.counts, workItems: record.workItems, reason: record.reason },
    },
    { type: "job.end", ts: record.endedAt, data: { status: record.status } },
  ];
  const { root } = writeSealedBundle(
    dir,
    {
      jobId,
      agent: `autopilot:${record.routineId}`,
      sessionKey: `autopilot:${record.projectId}:${record.routineId}`,
      kind: "autopilot.run",
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    },
    bodies,
    { env: opts.env },
  );
  return { bundle: path.relative(path.dirname(path.dirname(dir)), dir), root };
}
