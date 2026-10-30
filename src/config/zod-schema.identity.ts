import { z } from "zod";

// `gateway.identity` (see types.identity.ts). Provider ids appear in URLs: lowercase slugs.
// `scim` and `legacy` are reserved: they name the directory as a group-mapping source (and as
// the voucher of an e-mail) and the source of mappings written before scoping. `passkey` is the
// built-in provider (passkeys and one-time codes).
export const PASSKEY_PROVIDER_ID = "passkey";
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "scim",
  "legacy",
  PASSKEY_PROVIDER_ID,
]);
const ProviderId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits, -")
  .refine(
    (id) => !RESERVED_PROVIDER_IDS.has(id),
    "scim, legacy and passkey are reserved provider ids",
  );

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
    stepUpAcrValues: z
      .array(
        z
          .string()
          .regex(/^[\x21-\x7e]+$/)
          .max(256),
      )
      .max(10)
      .optional(),
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

/** Client id the command line uses for the device authorization grant; not a native client id. */
export const CLI_CLIENT_ID = "kurahi-cli";

const NativeClientSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "lowercase letters, digits, . and -")
      .refine((id) => id !== CLI_CLIENT_ID, `${CLI_CLIENT_ID} is reserved for the command line`),
    name: z.string().min(1).max(80),
    // RFC 8252 7.1: a private-use scheme in reverse-domain form (it contains a period).
    redirect: z.union([
      z.literal("loopback"),
      z
        .string()
        .max(128)
        .regex(/^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/, "loopback, or a reverse-domain URI scheme"),
    ]),
  })
  .strict();

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
    stepUp: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeSeconds: z.number().int().min(30).max(3600).optional(),
        requireMethods: z
          .array(z.string().regex(/^[a-z0-9_-]{1,64}$/i))
          .max(10)
          .optional(),
        actions: z
          .object({
            approvals: z
              .union([
                z.boolean(),
                z
                  .object({
                    amountAtLeast: z.number().finite().min(0).optional(),
                    amountField: z
                      .string()
                      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
                      .optional(),
                  })
                  .strict(),
              ])
              .optional(),
            autopilotLevel: z.boolean().optional(),
            emergencyStopRelease: z.boolean().optional(),
            identityAdmin: z.boolean().optional(),
            authenticatorChange: z.boolean().optional(),
            governance: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    nativeClients: z.array(NativeClientSchema).max(20).optional(),
    deviceSignIn: z.boolean().optional(),
    passkeys: z
      .object({
        enabled: z.boolean().optional(),
        rpId: z
          .string()
          .regex(
            /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
          )
          .optional(),
        rpName: z.string().min(1).max(64).optional(),
        userVerification: z.enum(["required", "preferred"]).optional(),
        allowedOrigins: z.array(z.string().url()).max(10).optional(),
        totp: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
