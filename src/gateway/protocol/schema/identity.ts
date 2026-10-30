// Enterprise identity protocol: who am I, the org directory (units, role assignments, group
// mappings) and SSO sessions. See docs/security/identity.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { ORG_ROLES } from "../../../identity/types.js";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

export const OrgRoleSchema = lit(ORG_ROLES);
const UnitId = Type.String({ pattern: "^[a-z0-9][a-z0-9_.-]{0,63}$" });
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Subject = Type.String({
  pattern: "^(person:[0-9a-f-]{36}|email:[^\\s@]+@[^\\s@]+)$",
  maxLength: 320,
  description: "`person:<id>` or `email:<address>` (matched at sign-in).",
});
const Group = Type.String({ minLength: 1, maxLength: 256 });

export const RoleGrantSchema = Type.Object({
  role: OrgRoleSchema,
  unit: Nullable(Type.String()),
  via: Type.String({ description: "assignment:<id>, group:<source>:<group> or default" }),
});

export const OrgUnitSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: lit(["department", "team"] as const),
  parentId: Nullable(Type.String()),
  department: Nullable(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const RoleAssignmentSchema = Type.Object({
  id: Type.String(),
  subject: Type.String(),
  role: OrgRoleSchema,
  unit: Nullable(Type.String()),
  createdAt: Type.String(),
  createdBy: Type.String(),
});

export const GroupMappingSchema = Type.Object({
  source: Type.String({ description: "scim, or the provider id that asserts the group" }),
  group: Type.String(),
  matchDisplayName: Type.Boolean(),
  roles: Type.Array(OrgRoleSchema),
  units: Type.Array(Type.String()),
  updatedAt: Type.String(),
  updatedBy: Type.String(),
});

const Evidence = Nullable(Type.Object({ bundle: Type.String(), root: Type.String() }));

export const IdentityWhoamiParamsSchema = strict({});
export const IdentityWhoamiResultSchema = Type.Object({
  kind: lit(["person", "owner", "pairing", "device", "agent"] as const),
  principal: Type.String(),
  person: Nullable(
    Type.Object({
      id: Type.String(),
      email: Nullable(Type.String()),
      displayName: Nullable(Type.String()),
      issuer: Nullable(Type.String()),
      subject: Nullable(Type.String()),
      providerId: Type.String(),
      groups: Type.Array(Type.String()),
    }),
  ),
  roles: Type.Array(RoleGrantSchema),
  units: Type.Array(Type.String()),
  scope: Type.String({ description: "observe | attach | admin | owner" }),
  adminAreas: Type.Array(lit(["identity", "sessions", "pairing", "policy", "config"] as const), {
    description: "Administrative areas of the person's roles (scopes operator.identity, …).",
  }),
  approvals: Type.Boolean({
    description: "Eligible for approval-type methods; stages still decide.",
  }),
  breakGlass: Type.Boolean(),
  session: Nullable(Type.Object({ id: Type.String(), expiresAt: Type.String() })),
  sso: Type.Object({
    required: Type.Boolean(),
    providers: Type.Array(
      Type.Object({
        id: Type.String(),
        kind: lit(["oidc", "saml"] as const),
        label: Type.String(),
      }),
    ),
  }),
});

export const IdentityOrgGetParamsSchema = strict({});
export const IdentityOrgGetResultSchema = Type.Object({
  org: Type.Object({ name: Nullable(Type.String()) }),
  units: Type.Array(OrgUnitSchema),
  /** Present for org-admin, security-admin, auditor and the owner. */
  assignments: Type.Optional(Type.Array(RoleAssignmentSchema)),
  mappings: Type.Optional(Type.Array(GroupMappingSchema)),
  persons: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        userName: Type.String(),
        displayName: Nullable(Type.String()),
        active: Type.Boolean(),
        source: Type.String(),
      }),
    ),
  ),
  /** Persons SCIM deleted; sign-in cannot re-create them until identity.persons.restore. */
  tombstones: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        personId: Type.String(),
        userName: Type.String(),
        deletedAt: Type.String(),
        deletedBy: Type.String(),
      }),
    ),
  ),
});

export const IdentityOrgUpdateParamsSchema = strict({
  name: Nullable(Type.String({ minLength: 1, maxLength: 200 })),
});
export const IdentityUnitsUpsertParamsSchema = strict({
  id: UnitId,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  kind: lit(["department", "team"] as const),
  parentId: Type.Optional(Nullable(UnitId)),
  department: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
});
export const IdentityUnitsRemoveParamsSchema = strict({ id: UnitId });
export const IdentityRolesAssignParamsSchema = strict({
  subject: Subject,
  role: OrgRoleSchema,
  unit: Type.Optional(Nullable(UnitId)),
});
export const IdentityRolesRevokeParamsSchema = strict({ id: Uuid });
const MappingSource = Type.String({
  pattern: "^(scim|[a-z0-9][a-z0-9-]{0,31})$",
  description: "`scim` (SCIM groups) or a provider id (groups that provider asserts).",
});
export const IdentityGroupMappingsSetParamsSchema = strict({
  source: MappingSource,
  group: Type.String({
    minLength: 1,
    maxLength: 256,
    description: "SCIM: the group id or externalId (immutable); provider: the asserted value.",
  }),
  matchDisplayName: Type.Optional(
    Type.Boolean({ description: "SCIM only: also match the (renamable) display name." }),
  ),
  roles: Type.Array(OrgRoleSchema, { minItems: 1, maxItems: 8 }),
  units: Type.Optional(Type.Array(UnitId, { maxItems: 50 })),
});
export const IdentityGroupMappingsRemoveParamsSchema = strict({
  source: MappingSource,
  group: Group,
});
export const IdentitySessionsListParamsSchema = strict({ personId: Type.Optional(Uuid) });
export const IdentitySessionsRevokeParamsSchema = strict({
  personId: Type.Optional(Uuid),
  sessionId: Type.Optional(Uuid),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
});

const ProviderId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" });
export const IdentityPersonsLinkParamsSchema = strict({
  personId: Uuid,
  providerId: ProviderId,
  subject: Type.String({
    minLength: 1,
    maxLength: 512,
    description: "The IdP subject (OIDC sub, SAML NameID).",
  }),
  issuer: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 1024,
      description: "Token issuer; default: the provider's issuer (OIDC) or IdP entity id (SAML).",
    }),
  ),
});
export const IdentityPersonsUnlinkParamsSchema = strict({ personId: Uuid, providerId: ProviderId });
export const IdentityPersonsRestoreParamsSchema = strict({
  tombstoneId: Uuid,
});

// Built-in sign-in (passkeys, one-time codes): persons created by an identity admin, one-time
// enrollment codes, and the authenticators a person holds (never keys or secrets).
export const IdentityPersonsCreateParamsSchema = strict({
  userName: Type.String({
    minLength: 1,
    maxLength: 256,
    description: "Unique sign-in name (often the e-mail); used for one-time code sign-in.",
  }),
  email: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});
export const IdentityAuthenticatorsEnrollParamsSchema = strict({
  personId: Uuid,
  ttlMinutes: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 4320, description: "Default 60, at most 72 hours." }),
  ),
});
export const IdentityAuthenticatorsEnrollResultSchema = Type.Object({
  ok: Type.Literal(true),
  enrollment: Type.Object({
    id: Type.String(),
    personId: Type.String(),
    expiresAt: Type.String(),
  }),
  code: Type.String({ description: "The one-time enrollment code (shown once, never stored)." }),
  link: Nullable(
    Type.String({ description: "Console link that opens enrollment (`#kurahi_enroll=…`)." }),
  ),
  evidence: Evidence,
});
export const IdentityAuthenticatorsListParamsSchema = strict({
  personId: Type.Optional(Uuid),
});
export const IdentityAuthenticatorsListResultSchema = Type.Object({
  persons: Type.Array(
    Type.Object({
      personId: Type.String(),
      passkeys: Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          createdAt: Type.String(),
          lastUsedAt: Nullable(Type.String()),
          synced: Type.Boolean(),
          transports: Type.Array(Type.String()),
        }),
      ),
      totp: Nullable(
        Type.Object({
          label: Type.String(),
          createdAt: Type.String(),
          lastUsedAt: Nullable(Type.String()),
        }),
      ),
      enrollments: Type.Array(
        Type.Object({
          id: Type.String(),
          state: lit(["pending", "used", "revoked", "expired"] as const),
          createdAt: Type.String(),
          createdBy: Type.String(),
          expiresAt: Type.String(),
          usedFor: Nullable(Type.String()),
        }),
      ),
    }),
  ),
});
export const IdentityAuthenticatorsRemoveParamsSchema = strict({
  personId: Uuid,
  passkeyId: Type.Optional(Type.String({ minLength: 1, maxLength: 1400 })),
  totp: Type.Optional(Type.Literal(true)),
  enrollmentId: Type.Optional(Uuid),
});

export const IdentityAdminResultSchema = Type.Object({
  ok: Type.Literal(true),
  unit: Type.Optional(OrgUnitSchema),
  assignment: Type.Optional(RoleAssignmentSchema),
  mapping: Type.Optional(GroupMappingSchema),
  revoked: Type.Optional(Type.Integer()),
  person: Type.Optional(
    Type.Object({
      id: Type.String(),
      links: Type.Array(
        Type.Object({ providerId: Type.String(), issuer: Type.String(), subject: Type.String() }),
      ),
    }),
  ),
  evidence: Evidence,
});

export const IdentitySessionsListResultSchema = Type.Object({
  sessions: Type.Array(
    Type.Object({
      id: Type.String(),
      personId: Type.String(),
      providerId: Type.String(),
      protocol: Type.String(),
      createdAt: Type.String(),
      lastSeenAt: Type.String(),
      expiresAt: Type.String(),
    }),
  ),
});
