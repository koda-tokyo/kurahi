import { z } from "zod";

// `gateway.identity` (see types.identity.ts). Provider ids appear in URLs: lowercase slugs.
// `scim` and `legacy` are reserved: they name the directory as a group-mapping source (and as
// the voucher of an e-mail) and the source of mappings written before scoping.
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(["scim", "legacy"]);
const ProviderId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits, -")
  .refine((id) => !RESERVED_PROVIDER_IDS.has(id), "scim and legacy are reserved provider ids");

const OidcProviderSchema = z
  .object({
    id: ProviderId,
    kind: z.literal("oidc"),
    label: z.string().max(80).optional(),
    issuer: z.string().url(),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).optional(),
    scopes: z
      .array(z.string().regex(/^[\x21-\x7e]+$/))
      .max(20)
      .optional(),
    groupsClaim: z.string().min(1).max(128).optional(),
    emailClaim: z.string().min(1).max(128).optional(),
    algorithms: z
      .array(z.enum(["RS256", "PS256", "ES256"]))
      .min(1)
      .optional(),
    allowedTenants: z.array(z.string().min(1).max(64)).max(100).optional(),
    allowedDomains: z.array(z.string().min(1).max(253)).max(100).optional(),
    trustEmailForLinking: z.boolean().optional(),
  })
  .strict();

const SamlProviderSchema = z
  .object({
    id: ProviderId,
    kind: z.literal("saml"),
    label: z.string().max(80).optional(),
    idpEntityId: z.string().min(1).max(1024),
    idpSsoUrl: z.string().url(),
    idpCertificates: z.array(z.string().min(1)).min(1).max(5),
    spEntityId: z.string().min(1).max(1024).optional(),
    nameIdFormats: z.array(z.string().min(1).max(256)).min(1).max(10).optional(),
    attributes: z
      .object({
        email: z.string().min(1).optional(),
        displayName: z.string().min(1).optional(),
        groups: z.string().min(1).optional(),
        givenName: z.string().min(1).optional(),
        familyName: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    allowedDomains: z.array(z.string().min(1).max(253)).max(100).optional(),
    trustEmailForLinking: z.boolean().optional(),
  })
  .strict();

const OrgRoleEnum = z.enum([
  "org-admin",
  "security-admin",
  "auditor",
  "department-manager",
  "approver",
  "operator",
  "member",
  "viewer",
]);

export const GatewayIdentitySchema = z
  .object({
    publicUrl: z.string().url().optional(),
    providers: z
      .array(z.discriminatedUnion("kind", [OidcProviderSchema, SamlProviderSchema]))
      .max(10)
      .optional(),
    ssoRequired: z.boolean().optional(),
    localPersons: z.boolean().optional(),
    breakGlass: z.object({ localOnly: z.boolean().optional() }).strict().optional(),
    session: z
      .object({
        lifetimeMinutes: z.number().int().positive().max(1440).optional(),
        idleMinutes: z.number().int().positive().max(1440).optional(),
      })
      .strict()
      .optional(),
    defaultRole: OrgRoleEnum.optional(),
    configRoles: z.array(OrgRoleEnum).max(8).optional(),
    clockSkewSeconds: z.number().int().min(0).max(300).optional(),
    scim: z
      .object({
        enabled: z.boolean().optional(),
        token: z.string().min(32).optional(),
        rateLimitPerMinute: z.number().int().positive().max(10_000).optional(),
        providerId: ProviderId.optional(),
      })
      .strict()
      .optional(),
    requireProvisioned: z.boolean().optional(),
  })
  .strict();
