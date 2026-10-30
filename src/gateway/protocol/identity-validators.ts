// Compiled validators for the identity methods (kept apart from protocol/index.ts).
import AjvPkg, { type ValidateFunction } from "ajv";
import {
  IdentityAuthenticatorsEnrollParamsSchema,
  IdentityAuthenticatorsListParamsSchema,
  IdentityAuthenticatorsRemoveParamsSchema,
  IdentityGroupMappingsRemoveParamsSchema,
  IdentityGroupMappingsSetParamsSchema,
  IdentityOrgGetParamsSchema,
  IdentityOrgUpdateParamsSchema,
  IdentityRolesAssignParamsSchema,
  IdentityRolesRevokeParamsSchema,
  IdentitySessionsListParamsSchema,
  IdentitySessionsRevokeParamsSchema,
  IdentityPersonsLinkParamsSchema,
  IdentityPersonsUnlinkParamsSchema,
  IdentityPersonsRestoreParamsSchema,
  IdentityPersonsCreateParamsSchema,
  IdentityUnitsRemoveParamsSchema,
  IdentityUnitsUpsertParamsSchema,
  IdentityWhoamiParamsSchema,
} from "./schema/identity.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

// Compiled on first use (import stays cheap).
function lazyCompile(schema: object): ValidateFunction {
  let compiled: ValidateFunction | null = null;
  const validate = ((data: unknown) =>
    (compiled ??= ajv.compile(schema))(data)) as ValidateFunction;
  Object.defineProperty(validate, "errors", {
    configurable: true,
    enumerable: true,
    get: () => compiled?.errors ?? null,
  });
  return validate;
}

export const identityValidators = {
  "identity.whoami": lazyCompile(IdentityWhoamiParamsSchema),
  "identity.org.get": lazyCompile(IdentityOrgGetParamsSchema),
  "identity.org.update": lazyCompile(IdentityOrgUpdateParamsSchema),
  "identity.units.upsert": lazyCompile(IdentityUnitsUpsertParamsSchema),
  "identity.units.remove": lazyCompile(IdentityUnitsRemoveParamsSchema),
  "identity.roles.assign": lazyCompile(IdentityRolesAssignParamsSchema),
  "identity.roles.revoke": lazyCompile(IdentityRolesRevokeParamsSchema),
  "identity.groupMappings.set": lazyCompile(IdentityGroupMappingsSetParamsSchema),
  "identity.groupMappings.remove": lazyCompile(IdentityGroupMappingsRemoveParamsSchema),
  "identity.sessions.list": lazyCompile(IdentitySessionsListParamsSchema),
  "identity.sessions.revoke": lazyCompile(IdentitySessionsRevokeParamsSchema),
  "identity.persons.link": lazyCompile(IdentityPersonsLinkParamsSchema),
  "identity.persons.unlink": lazyCompile(IdentityPersonsUnlinkParamsSchema),
  "identity.persons.restore": lazyCompile(IdentityPersonsRestoreParamsSchema),
  "identity.persons.create": lazyCompile(IdentityPersonsCreateParamsSchema),
  "identity.authenticators.enroll": lazyCompile(IdentityAuthenticatorsEnrollParamsSchema),
  "identity.authenticators.list": lazyCompile(IdentityAuthenticatorsListParamsSchema),
  "identity.authenticators.remove": lazyCompile(IdentityAuthenticatorsRemoveParamsSchema),
} as const;

export type IdentityMethod = keyof typeof identityValidators;
