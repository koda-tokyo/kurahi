// Enterprise identity (Kurahi Wave 1): shared types. Nothing here runs at import time.
//
// A *person* is a human signed in through the organisation's identity provider (OIDC or SAML)
// or provisioned by SCIM. Persons are distinct from devices (pairing credentials, device keys)
// and from agents (backend tool connections): a person's principal is `person:<id>`, and the
// person-only gates (work item decisions, autopilot approvals) still refuse every agent origin
// whatever roles the session carries.

export const ORG_ROLES = [
  "org-admin",
  "security-admin",
  "auditor",
  "department-manager",
  "approver",
  "operator",
  "member",
  "viewer",
] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

export type OrgUnitKind = "department" | "team";

export type OrgUnit = {
  id: string;
  name: string;
  kind: OrgUnitKind;
  /** Teams belong to a department (or another team); departments may nest. Null at the top. */
  parentId: string | null;
  /** Optional link to a Business department id (secretariat, finance, …) for work queues. */
  department: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Who a role assignment names: a person by id, or an e-mail matched at sign-in. */
export type AssignmentSubject = `person:${string}` | `email:${string}`;

export type RoleAssignment = {
  id: string;
  subject: AssignmentSubject;
  role: OrgRole;
  /** Org unit the role applies to (department-manager / approver of one unit), or null. */
  unit: string | null;
  createdAt: string;
  createdBy: string;
};

/**
 * Group → roles. Scoped by `source`: "scim" (SCIM groups, matched by their immutable id or
 * externalId; by display name only with `matchDisplayName`) or a provider id (the group values
 * that provider asserts at sign-in). Mappings written before scoping load with source
 * "legacy" and match nothing until an admin sets them again.
 */
export type GroupMapping = {
  source: string;
  group: string;
  matchDisplayName: boolean;
  roles: OrgRole[];
  units: string[];
  updatedAt: string;
  updatedBy: string;
};

export type PersonLink = { providerId: string; issuer: string; subject: string };

export type Person = {
  id: string;
  /** SCIM userName (often the UPN or e-mail); unique, compared case-insensitively. */
  userName: string;
  externalId: string | null;
  email: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  active: boolean;
  /** Sign-in links (issuer + subject per provider). */
  links: PersonLink[];
  /**
   * Who vouched for `email`: "scim" (the provisioning directory) or the id of a provider with
   * `trustEmailForLinking` that asserted it as verified. Null when nobody did: such an e-mail is
   * shown but never links accounts or matches `email:` role assignments. Absent in directories
   * written before this field existed (SCIM persons then count as "scim").
   */
  emailVerifiedBy?: string | null;
  /** Group values from the last sign-in token or assertion. */
  claimGroups: string[];
  /** Provider that asserted `claimGroups` (absent in older directories: then they match nothing). */
  claimGroupsFrom?: string | null;
  source: "scim" | "sso";
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  deactivatedAt: string | null;
};

/** A person deleted by SCIM: blocks just-in-time re-creation by sign-in until restored. */
export type Tombstone = {
  id: string;
  personId: string;
  userName: string;
  email: string | null;
  externalId: string | null;
  links: PersonLink[];
  deletedAt: string;
  deletedBy: string;
};

export type ScimGroup = {
  id: string;
  displayName: string;
  externalId: string | null;
  members: string[];
  createdAt: string;
  updatedAt: string;
};

export type SsoSession = {
  id: string;
  tokenHash: string;
  personId: string;
  providerId: string;
  protocol: "oidc" | "saml";
  createdAt: string;
  lastSeenAt: string;
  /** Absolute end of the session. */
  expiresAt: string;
  idleTimeoutMs: number;
  /** OIDC: the raw ID token kept only for RP-initiated logout (`id_token_hint`). */
  idTokenHint: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
};

/** The person's grants as resolved now: direct assignments plus group mappings. */
export type RoleGrant = { role: OrgRole; unit: string | null; via: string };

/**
 * Administrative areas a person's roles open, each with its own legacy scope (never
 * `operator.admin`): identity → identity.* admin methods (`operator.identity`); sessions →
 * identity.sessions.* (`operator.identity`); pairing → device / node pairing
 * (`operator.pairing`); policy → the kill switch (`operator.policy`); config → host-level
 * methods such as config.*, cron edits and skills (`operator.config`), granted only to roles
 * listed in `gateway.identity.configRoles` (none by default).
 */
export type AdminArea = "identity" | "sessions" | "pairing" | "policy" | "config";

/** What a verified SSO session gives a request. Recomputed on every check. */
export type PersonPrincipal = {
  kind: "person";
  personId: string;
  /** `person:<id>`: the principal string used by projects, work items and audit. */
  principal: string;
  sessionId: string;
  providerId: string;
  issuer: string | null;
  subject: string | null;
  email: string | null;
  displayName: string | null;
  /** Scoped group values: `scim:<group id or externalId>`, `<providerId>:<asserted value>`. */
  groups: string[];
  roles: RoleGrant[];
  units: string[];
  /** `role:<role>@<unit>` for every unit a unit-scoped role covers (the unit and below). */
  coverage: string[];
  /** Gateway scope from the highest role (never owner; no role maps to admin). */
  scope: "observe" | "attach" | "admin";
  /** Administrative areas from the roles (see AdminArea); empty for most people. */
  adminAreas: AdminArea[];
  /** Eligible for approval-type methods (operator.approvals); the stage rules still decide. */
  approvals: boolean;
  expiresAt: string;
};

/** Identity claims an IdP asserted for one sign-in (OIDC ID token or SAML assertion). */
export type SignInClaims = {
  providerId: string;
  protocol: "oidc" | "saml";
  issuer: string;
  subject: string;
  email: string | null;
  /**
   * The IdP vouched for the e-mail: OIDC `email_verified === true`; SAML an e-mail attribute or
   * an `emailAddress` NameID of the signed assertion. Linking by e-mail still needs the
   * provider's `trustEmailForLinking`.
   */
  emailVerified: boolean;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  groups: string[];
  idTokenHint: string | null;
};

export const PERSON_PRINCIPAL_PREFIX = "person:";
export const SSO_SESSION_PREFIX = "kss_";
