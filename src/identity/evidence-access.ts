// Which job evidence an SSO person may read (getJobEvidence, listJobEvidenceEvents,
// exportJobEvidence, getEvidenceView). The route gate only checks the scope (attach, or the
// auditor exception); this is the per-job read policy, the same Project access the work queue
// uses for persons:
//
//   - org-admin or auditor without a unit: every job;
//   - a job of a Project session (`agent:<id>:proj-<project>-<chat>`): persons the Project's
//     access policy lists, directly (`access.members`) or through an exported group
//     (`access.groups`: `role:<role>`, `role:<role>@<unit>`, `unit:<unit>`, `group:<IdP group>`),
//     which covers Project members, unit members, approvers and managers the Project names;
//   - a unit-scoped auditor or org-admin: jobs of Projects whose access policy names a unit that
//     role covers (the unit or one below it);
//   - any other job (no Project, unknown Project): no person below org-wide org-admin / auditor.
//
// Non-person credentials (owner, pairing) keep their own rules in http-evidence.ts.
import type { PersonPrincipal } from "./types.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import { getProject } from "../projects/store.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { projectGroupsFor } from "./rbac.js";

const ORG_WIDE_EVIDENCE_ROLES = new Set(["org-admin", "auditor"]);
const UNIT_EVIDENCE_COVERAGE_RE = /^role:(?:org-admin|auditor)@(.+)$/;

/** Units a Project's access policy names (`unit:<u>` and `role:<r>@<u>` group keys). */
function projectUnits(groups: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(groups)) {
    if (key.startsWith("unit:")) {
      out.add(key.slice("unit:".length));
      continue;
    }
    const at = /^role:[^@]+@(.+)$/.exec(key);
    if (at) {
      out.add(at[1]);
    }
  }
  return out;
}

export function personMayReadJobEvidence(
  person: Pick<PersonPrincipal, "principal" | "roles" | "units" | "groups" | "coverage">,
  job: { sessionKey: string; projectId?: string | null },
  opts: { home?: string } = {},
): boolean {
  if (person.roles.some((g) => ORG_WIDE_EVIDENCE_ROLES.has(g.role) && g.unit === null)) {
    return true;
  }
  const projectId = parseProjectSessionKey(job.sessionKey)?.projectId ?? job.projectId ?? null;
  if (!projectId) {
    return false;
  }
  const project = getProject(projectId, opts.home);
  if (!project) {
    return false;
  }
  const access = loadWorkQueuePolicy(project, opts.home).access;
  if (access.members.some((m) => m.principal === person.principal)) {
    return true;
  }
  const mine = projectGroupsFor(person);
  if (mine.some((g) => Object.hasOwn(access.groups, g))) {
    return true;
  }
  const units = projectUnits(access.groups);
  return person.coverage.some((c) => {
    const m = UNIT_EVIDENCE_COVERAGE_RE.exec(c);
    return m !== null && units.has(m[1]);
  });
}
