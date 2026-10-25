// Enterprise identity HTTP routes (declarations): SSO sign-in, session, logout, SCIM 2.0.
// Bound in server-http.ts; see docs/security/identity.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { defineRoute, type RouteDefinition } from "./http-registry.js";

const Loose = (properties: Record<string, TSchema>, description?: string) =>
  Type.Object(properties, { additionalProperties: true, ...(description ? { description } : {}) });

const tags = ["identity"];
const scimTags = ["scim"];
const ProviderParam = Type.Object({
  provider: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$", description: "Provider id" }),
});
const IdParam = Type.Object({ id: Type.String({ description: "Resource id" }) });
const Redirect = (description: string) => ({
  description,
  headers: { Location: { description: "Where the browser goes next.", schema: Type.String() } },
});
const ScimJson = "application/scim+json";
const ScimResource = Loose({ schemas: Type.Array(Type.String()), id: Type.String() });
const ScimList = Loose({
  schemas: Type.Array(Type.String()),
  totalResults: Type.Integer(),
  startIndex: Type.Integer(),
  itemsPerPage: Type.Integer(),
  Resources: Type.Array(Loose({})),
});
const ScimError = Loose({
  schemas: Type.Array(Type.String()),
  status: Type.String(),
  detail: Type.String(),
});
const scimErrors = {
  400: { description: "Invalid request or filter.", schema: ScimError, contentType: ScimJson },
  401: "Unauthorized" as const,
  404: { description: "Not found, or SCIM is off.", schema: ScimError, contentType: ScimJson },
  409: {
    description: "userName or displayName already in use.",
    schema: ScimError,
    contentType: ScimJson,
  },
};
const ListQuery = Type.Object({
  filter: Type.Optional(Type.String({ description: 'e.g. userName eq "alice@example.com"' })),
  startIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  count: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
  excludedAttributes: Type.Optional(Type.String({ description: "Groups: `members`" })),
});
const RoleGrant = Loose({
  role: Type.String(),
  unit: Type.Union([Type.String(), Type.Null()]),
  via: Type.String(),
});

function scimRoute(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  operationId: string,
  summary: string,
  extra: Partial<RouteDefinition> = {},
): RouteDefinition {
  return defineRoute({
    method,
    path,
    operationId,
    summary,
    tags: scimTags,
    auth: "scim-token",
    responses: {
      ...(method === "DELETE"
        ? { 204: { description: "Deleted." } }
        : method === "POST"
          ? { 201: { description: "Created.", schema: ScimResource, contentType: ScimJson } }
          : {
              200: {
                description: "Resource or list.",
                schema: path.includes("{id}") ? ScimResource : ScimList,
                contentType: ScimJson,
              },
            }),
      ...scimErrors,
    },
    ...extra,
  });
}

export const IDENTITY_ROUTES: readonly RouteDefinition[] = [
  defineRoute({
    method: "GET",
    path: "/api/identity/sso",
    operationId: "getSsoConfig",
    summary: "SSO providers the console offers, and whether SSO is required",
    tags,
    auth: "none",
    responses: {
      200: {
        description: "Sign-in options (no secrets).",
        schema: Type.Object({
          enabled: Type.Boolean(),
          required: Type.Boolean(),
          providers: Type.Array(
            Type.Object({
              id: Type.String(),
              kind: Type.Union([Type.Literal("oidc"), Type.Literal("saml")]),
              label: Type.String(),
              loginPath: Type.String(),
            }),
          ),
        }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/login",
    operationId: "startSsoLogin",
    summary: "Start a sign-in (redirect to the identity provider)",
    description:
      "OIDC: authorization code + PKCE (S256) with state and nonce. SAML: HTTP-Redirect " +
      "AuthnRequest. `returnTo` must be a console path (under the control UI base path), else " +
      "the console root. A one-time code comes back to it in the fragment (`#sso_code=…`), " +
      "for exchangeSsoCode; a refusal as `#sso_error=<reason>`.",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      query: Type.Object({ returnTo: Type.Optional(Type.String({ maxLength: 512 })) }),
    },
    responses: { 302: Redirect("To the identity provider."), 404: "NotFound" },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/callback",
    operationId: "ssoCallback",
    summary: "OIDC redirect URI (authorization code callback)",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      query: Type.Object({
        code: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
      }),
    },
    responses: {
      302: Redirect("Back to the console with `#sso_code=` or `#sso_error=`."),
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/sso/{provider}/acs",
    operationId: "samlAcs",
    summary: "SAML assertion consumer service (HTTP-POST binding)",
    description:
      "Accepts a SAMLResponse answering a request this gateway sent. The assertion must be " +
      "signed by a configured IdP certificate; audience, recipient, time window and replay are " +
      "checked. IdP-initiated sign-in is not accepted.",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      body: Type.Object({ SAMLResponse: Type.String(), RelayState: Type.Optional(Type.String()) }),
      bodyContentType: "application/x-www-form-urlencoded",
      bodyRequired: true,
    },
    responses: {
      303: Redirect("Back to the console with `#sso_code=` or `#sso_error=`."),
      404: "NotFound",
      413: "PayloadTooLarge",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/metadata",
    operationId: "getSamlMetadata",
    summary: "SAML service provider metadata (entity id, ACS URL)",
    tags,
    auth: "none",
    request: { params: ProviderParam },
    responses: {
      200: {
        description: "SP metadata XML.",
        schema: Type.String(),
        contentType: "application/samlmetadata+xml",
      },
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/sso/exchange",
    operationId: "exchangeSsoCode",
    summary: "Exchange the sign-in's one-time code for the session token",
    description:
      "The console posts the code from `#sso_code=`. A code works once, for 60 seconds, and " +
      "only with the binding cookie of the browser that started the sign-in; a refused or " +
      "expired code ends its session.",
    tags,
    auth: "none",
    request: {
      body: Type.Object({ code: Type.String({ maxLength: 128 }) }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The SSO session token (`kss_…`).",
        schema: Type.Object({ token: Type.String() }),
      },
      400: {
        description: "Unknown, used or expired code, or another browser.",
        schema: Loose({ error: Loose({ message: Type.String(), type: Type.String() }) }),
      },
      429: "TooManyRequests",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/session",
    operationId: "getIdentitySession",
    summary: "The signed-in person, roles and session expiry",
    tags,
    auth: "sso-session",
    minScope: "observe",
    responses: {
      200: {
        description: "Person session.",
        schema: Type.Object({
          ok: Type.Literal(true),
          principal: Type.String(),
          person: Loose({ id: Type.String() }),
          roles: Type.Array(RoleGrant),
          units: Type.Array(Type.String()),
          scope: Type.String(),
          approvals: Type.Boolean(),
          session: Type.Object({ id: Type.String(), expiresAt: Type.String() }),
        }),
      },
      401: "Unauthorized",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/logout",
    operationId: "logoutIdentity",
    summary: "End the SSO session (and get the IdP logout URL for OIDC)",
    tags,
    auth: "sso-session",
    minScope: "observe",
    responses: {
      200: {
        description: "Session ended; open connections of the session close.",
        schema: Type.Object({
          ok: Type.Literal(true),
          endSessionUrl: Type.Union([Type.String(), Type.Null()], {
            description:
              "RP-initiated logout at the IdP (OIDC end_session_endpoint), when published.",
          }),
        }),
      },
      401: "Unauthorized",
    },
  }),
  scimRoute(
    "GET",
    "/scim/v2/ServiceProviderConfig",
    "getScimServiceProviderConfig",
    "SCIM service provider configuration",
  ),
  scimRoute("GET", "/scim/v2/ResourceTypes", "listScimResourceTypes", "SCIM resource types"),
  scimRoute("GET", "/scim/v2/Schemas", "listScimSchemas", "SCIM schemas"),
  scimRoute(
    "GET",
    "/scim/v2/Users",
    "listScimUsers",
    "List users (filter userName eq / externalId eq)",
    {
      request: { query: ListQuery },
    },
  ),
  scimRoute("POST", "/scim/v2/Users", "createScimUser", "Provision a user", {
    request: {
      body: Loose({ userName: Type.String() }),
      bodyContentType: ScimJson,
      bodyRequired: true,
    },
  }),
  scimRoute("GET", "/scim/v2/Users/{id}", "getScimUser", "Read a user", {
    request: { params: IdParam },
  }),
  scimRoute("PUT", "/scim/v2/Users/{id}", "replaceScimUser", "Replace a user", {
    request: { params: IdParam, body: Loose({}), bodyContentType: ScimJson, bodyRequired: true },
  }),
  scimRoute(
    "PATCH",
    "/scim/v2/Users/{id}",
    "patchScimUser",
    "Patch a user (active: false deprovisions)",
    {
      request: {
        params: IdParam,
        body: Loose({ Operations: Type.Array(Loose({})) }),
        bodyContentType: ScimJson,
        bodyRequired: true,
      },
    },
  ),
  scimRoute("DELETE", "/scim/v2/Users/{id}", "deleteScimUser", "Delete a user (ends sessions)", {
    request: { params: IdParam },
  }),
  scimRoute(
    "GET",
    "/scim/v2/Groups",
    "listScimGroups",
    "List groups (filter displayName eq / externalId eq)",
    {
      request: { query: ListQuery },
    },
  ),
  scimRoute("POST", "/scim/v2/Groups", "createScimGroup", "Provision a group", {
    request: {
      body: Loose({ displayName: Type.String() }),
      bodyContentType: ScimJson,
      bodyRequired: true,
    },
  }),
  scimRoute("GET", "/scim/v2/Groups/{id}", "getScimGroup", "Read a group", {
    request: { params: IdParam },
  }),
  scimRoute("PUT", "/scim/v2/Groups/{id}", "replaceScimGroup", "Replace a group", {
    request: { params: IdParam, body: Loose({}), bodyContentType: ScimJson, bodyRequired: true },
  }),
  scimRoute(
    "PATCH",
    "/scim/v2/Groups/{id}",
    "patchScimGroup",
    "Patch a group (members add / remove)",
    {
      request: {
        params: IdParam,
        body: Loose({ Operations: Type.Array(Loose({})) }),
        bodyContentType: ScimJson,
        bodyRequired: true,
      },
    },
  ),
  scimRoute("DELETE", "/scim/v2/Groups/{id}", "deleteScimGroup", "Delete a group", {
    request: { params: IdParam },
  }),
];

export const SCIM_OPERATION_IDS = IDENTITY_ROUTES.filter((r) => r.auth === "scim-token").map(
  (r) => r.operationId,
);
