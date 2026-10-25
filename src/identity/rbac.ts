// Roles → gateway scopes and project access.
//
//   role                gateway scope   approvals   notes
//   org-admin           attach          yes         + identity admin: units, roles, mappings, sessions
//   security-admin      attach          yes         + sessions, pairing, policy kill switch
//   auditor             observe         no          + audit chain and evidence reads (HTTP)
//   department-manager  attach          yes         usually scoped to a unit
//   approver            attach          yes         eligibility only: route stages decide
//   operator            attach          yes         runs agents, stops routines
//   member              attach          no
//   viewer              observe         no
//
// No role maps to the gateway `admin` scope or to `operator.admin`: identity administration has
// its own scopes (AdminArea), and host-level methods (config.*, cron, skills, …) need the owner
// or `operator.config`, which only `gateway.identity.configRoles` grants.
//
// A role never makes an agent a person, and approval eligibility never decides a stage: work
// item stages still check their own approvers (`access.members` / `access.groups` of the Project,
// which can name the groups exported below).
import type { IdentitySettings } from "./config.js";
import type { GroupMemberships, IdentityStore } from "./store.js";
import {
  type AdminArea,
  type GroupMapping,
  type OrgRole,
  PERSON_PRINCIPAL_PREFIX,
  type Person,
  type PersonPrincipal,
  type RoleGrant,
  type SsoSession,
} from "./types.js";

const ROLE_SCOPE: Record<OrgRole, PersonPrincipal["scope"]> = {
  "org-admin": "attach",
  "security-admin": "attach",
  auditor: "observe",
  "department-manager": "attach",
  approver: "attach",
  operator: "attach",
  member: "attach",
  viewer: "observe",
};

const APPROVAL_ROLES = new Set<OrgRole>([
  "org-admin",
  "security-admin",
  "department-manager",
  "approver",
  "operator",
]);

const SCOPE_RANK = { observe: 0, attach: 1, admin: 2 } as const;

const ROLE_ADMIN_AREAS: Partial<Record<OrgRole, AdminArea[]>> = {
  "org-admin": ["identity", "sessions"],
  "security-admin": ["sessions", "pairing", "policy"],
};

export function adminAreasForRoles(
  roles: OrgRole[],
  settings: Pick<IdentitySettings, "configRoles">,
): AdminArea[] {
  const out = new Set<AdminArea>();
  for (const r of roles) {
    for (const a of ROLE_ADMIN_AREAS[r] ?? []) {
      out.add(a);
    }
    if (settings.configRoles.includes(r)) {
      out.add("config");
    }
  }
  return [...out];
}

/** Legacy scope per admin area (the method gate in server-methods.ts checks these). */
export const IDENTITY_SCOPE = "operator.identity";
export const POLICY_SCOPE = "operator.policy";
export const CONFIG_SCOPE = "operator.config";

/** Roles that may read the identity directory (assignments, mappings). */
export const DIRECTORY_READ_ROLES = new Set<OrgRole>(["org-admin", "security-admin", "auditor"]);

export function scopeForRoles(roles: OrgRole[]): PersonPrincipal["scope"] | null {
  let best: PersonPrincipal["scope"] | null = null;
  for (const r of roles) {
    const s = ROLE_SCOPE[r];
    if (!best || SCOPE_RANK[s] > SCOPE_RANK[best]) {
      best = s;
    }
  }
  return best;
}

export function approvalsForRoles(roles: OrgRole[]): boolean {
  return roles.some((r) => APPROVAL_ROLES.has(r));
}

/**
 * Legacy `operator.*` scopes for the method gate. Never `operator.admin`: admin areas add their
 * own narrow scopes.
 */
export function legacyScopesForPerson(
  p: Pick<PersonPrincipal, "scope" | "approvals"> & { adminAreas?: AdminArea[] },
): string[] {
  const out = p.scope === "observe" ? ["operator.read"] : ["operator.read", "operator.write"];
  if (p.approvals && p.scope !== "observe") {
    out.push("operator.approvals");
  }
  const areas = p.adminAreas ?? [];
  if (areas.includes("identity") || areas.includes("sessions")) {
    out.push(IDENTITY_SCOPE);
  }
  if (areas.includes("pairing")) {
    out.push("operator.pairing");
  }
  if (areas.includes("policy")) {
    out.push(POLICY_SCOPE);
  }
  if (areas.includes("config")) {
    out.push(CONFIG_SCOPE);
  }
  return out;
}

/** True when a person's admin areas open this WS method (the handler still checks roles). */
export function adminAreaAllows(
  p: Pick<PersonPrincipal, "adminAreas">,
  method: string,
  kind: { pairing: boolean; hostLevel: boolean },
): boolean {
  const areas = p.adminAreas;
  if (method.startsWith("identity.")) {
    return (
      areas.includes("identity") ||
      (areas.includes("sessions") && method.startsWith("identity.sessions."))
    );
  }
  if (kind.pairing) {
    return areas.includes("pairing");
  }
  if (method === "policy.kill" || method === "policy.release") {
    return areas.includes("policy");
  }
  return kind.hostLevel && areas.includes("config");
}

export function personPrincipalId(personId: string): string {
  return `${PERSON_PRINCIPAL_PREFIX}${personId}`;
}

/** True when this provider's verified e-mails may link accounts and match `email:` grants. */
export function providerTrustsEmail(
  settings: Pick<IdentitySettings, "providers">,
  providerId: string,
): boolean {
  return settings.providers.some((p) => p.id === providerId && p.trustEmailForLinking === true);
}

/**
 * The e-mail addresses `email:` assignments may match: a SCIM-provisioned userName or e-mail
 * (the directory is authoritative), or an e-mail a provider with `trustEmailForLinking` asserted
 * as verified. An e-mail nobody vouched for matches nothing.
 */
export function trustedEmailsOf(
  person: Person,
  settings: Pick<IdentitySettings, "providers">,
): string[] {
  const out = new Set<string>();
  const lower = (v: string) => v.trim().toLowerCase();
  if (person.source === "scim" && person.userName.includes("@")) {
    out.add(lower(person.userName));
  }
  if (person.email) {
    // Directories written before `emailVerifiedBy` existed: only SCIM e-mails were provisioned.
    const by =
      person.emailVerifiedBy === undefined
        ? person.source === "scim"
          ? "scim"
          : null
        : person.emailVerifiedBy;
    if (by === "scim" || (by !== null && providerTrustsEmail(settings, by))) {
      out.add(lower(person.email));
    }
  }
  return [...out];
}

/**
 * A mapping matches only groups of its own source: a SCIM group by id or externalId (by display
 * name only when the mapping opts in), or a value the mapping's provider asserted at the
 * person's last sign-in. A value from one provider never satisfies another provider's mapping.
 */
export function mappingMatches(m: GroupMapping, memberships: GroupMemberships): boolean {
  if (m.source === "scim") {
    return memberships.scim.some(
      (g) =>
        g.id === m.group ||
        (g.externalId !== null && g.externalId === m.group) ||
        (m.matchDisplayName && g.displayName.toLowerCase() === m.group.toLowerCase()),
    );
  }
  return memberships.claims.providerId === m.source && memberships.claims.values.includes(m.group);
}

/** Direct assignments (by person id or trusted e-mail) plus mappings of the person's groups. */
export function resolveGrants(
  store: IdentityStore,
  person: Person,
  settings: Pick<IdentitySettings, "defaultRole" | "providers">,
): { grants: RoleGrant[]; groups: string[] } {
  const all = store.groupMembershipsOf(person.id);
  // Groups a provider asserted count only while that provider is configured: removing a
  // provider from `gateway.identity.providers` withdraws what it vouched for.
  const claimsFrom = all.claims.providerId;
  const staleClaims = claimsFrom !== null && !settings.providers.some((p) => p.id === claimsFrom);
  const memberships = staleClaims ? { ...all, claims: { providerId: null, values: [] } } : all;
  const groups = store
    .groupValuesOf(person.id)
    .filter((g) => !staleClaims || !g.startsWith(`${claimsFrom}:`));
  const subjects = new Set<string>([personPrincipalId(person.id)]);
  for (const e of trustedEmailsOf(person, settings)) {
    subjects.add(`email:${e}`);
  }
  const grants: RoleGrant[] = [];
  for (const a of store.listAssignments()) {
    if (subjects.has(a.subject)) {
      grants.push({ role: a.role, unit: a.unit, via: `assignment:${a.id}` });
    }
  }
  for (const m of store.listMappings()) {
    if (!mappingMatches(m, memberships)) {
      continue;
    }
    const via = `group:${m.source}:${m.group}`;
    for (const role of m.roles) {
      if (m.units.length === 0) {
        grants.push({ role, unit: null, via });
      }
      for (const unit of m.units) {
        grants.push({ role, unit, via });
      }
    }
  }
  if (grants.length === 0 && settings.defaultRole) {
    grants.push({ role: settings.defaultRole, unit: null, via: "default" });
  }
  return { grants, groups };
}

/** The principal a verified session gives, or null when the person may not act at all. */
export function buildPersonPrincipal(
  store: IdentityStore,
  settings: Pick<IdentitySettings, "defaultRole" | "providers" | "configRoles">,
  session: Pick<SsoSession, "id" | "personId" | "providerId" | "expiresAt">,
): { ok: true; principal: PersonPrincipal } | { ok: false; reason: string } {
  const person = store.getPerson(session.personId);
  if (!person) {
    return { ok: false, reason: "person_deleted" };
  }
  // A session opened through a provider that is no longer configured (or no longer usable) ends.
  if (session.providerId && !settings.providers.some((p) => p.id === session.providerId)) {
    return { ok: false, reason: "provider_removed" };
  }
  if (!person.active) {
    return { ok: false, reason: "person_inactive" };
  }
  const { grants, groups } = resolveGrants(store, person, settings);
  const roles = [...new Set(grants.map((g) => g.role))];
  const scope = scopeForRoles(roles);
  if (!scope) {
    return { ok: false, reason: "no_role" };
  }
  const units = new Set<string>();
  const covered: string[] = [];
  for (const g of grants) {
    if (g.unit) {
      for (const u of store.unitAncestry(g.unit)) {
        units.add(u);
      }
      for (const u of store.unitDescendants(g.unit)) {
        covered.push(`role:${g.role}@${u}`);
      }
    }
  }
  const link = person.links.find((l) => l.providerId === session.providerId) ?? null;
  return {
    ok: true,
    principal: {
      kind: "person",
      personId: person.id,
      principal: personPrincipalId(person.id),
      sessionId: session.id,
      providerId: session.providerId,
      issuer: link?.issuer ?? null,
      subject: link?.subject ?? null,
      email: person.email,
      displayName: person.displayName,
      groups,
      roles: grants,
      units: [...units],
      coverage: [...new Set(covered)],
      scope,
      adminAreas: adminAreasForRoles(roles, settings),
      approvals: approvalsForRoles(roles),
      expiresAt: session.expiresAt,
    },
  };
}

export function hasRole(p: Pick<PersonPrincipal, "roles">, ...roles: OrgRole[]): boolean {
  return p.roles.some((g) => roles.includes(g.role));
}

/**
 * Group ids a person exports to Project access policies (`access.groups` keys):
 * `role:<role>`, `role:<role>@<unit>` (the unit and the units below it), `unit:<unit>` (the
 * unit and the units above it) and `group:<source>:<value>` (`group:scim:<group id>`,
 * `group:<providerId>:<asserted value>`).
 */
export function projectGroupsFor(
  p: Pick<PersonPrincipal, "roles" | "units" | "groups" | "coverage">,
): string[] {
  const out = new Set<string>();
  for (const g of p.roles) {
    out.add(`role:${g.role}`);
  }
  for (const c of p.coverage) {
    out.add(c);
  }
  for (const u of p.units) {
    out.add(`unit:${u}`);
  }
  for (const g of p.groups) {
    out.add(`group:${g}`.slice(0, 128));
  }
  return [...out];
}
