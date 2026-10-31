// Kurahi Guardian config (docs/security/guardian.md). Mirrors types.guardian.ts.
import { z } from "zod";

/** POSIX `/…`, Windows `C:\…` / `C:/…`, or UNC `\\server\share…`; never relative. */
export function isAbsoluteConfigPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
}

const AbsPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsoluteConfigPath, { message: "must be an absolute path" });

/** Lowercase host name in dot-separated labels; no wildcard, no scheme, no trailing dot. */
const Domain = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/,
    "must be a lowercase domain name (no wildcard, scheme or path)",
  );

const ExposureSchema = z
  .object({
    enabled: z.boolean().optional(),
    domains: z.array(Domain).max(20).optional(),
    emailDomains: z.array(Domain).max(20).optional(),
    brandTerms: z.array(z.string().trim().min(3).max(60)).max(20).optional(),
    crawl: z
      .object({
        maxPages: z.number().int().min(1).max(5000).optional(),
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 ** 3)
          .optional(),
        maxDepth: z.number().int().min(0).max(10).optional(),
      })
      .strict()
      .optional(),
    lookalikes: z
      .object({
        max: z.number().int().min(1).max(1000).optional(),
        ignore: z.array(Domain).max(500).optional(),
      })
      .strict()
      .optional(),
    hibp: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    github: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    people: z
      .object({
        enabled: z.boolean().optional(),
        retentionDays: z.number().int().min(0).max(3650).optional(),
        platforms: z
          .array(z.string().regex(/^[a-z0-9-]{2,30}$/))
          .max(15)
          .optional(),
        hibp: z.object({ enabled: z.boolean().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const GuardianSchema = z
  .object({
    enabled: z.boolean().optional(),
    shares: z.array(AbsPath).max(64).optional(),
    scan: z
      .object({
        engine: z.enum(["auto", "clamav", "defender", "yara", "none"]).optional(),
        maxFiles: z.number().int().min(1).max(10_000_000).optional(),
        maxBytes: z.number().int().min(1).optional(),
        yaraRules: AbsPath.optional(),
        quarantine: z
          .object({ dir: AbsPath.optional(), mode: z.enum(["copy", "move"]).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    posture: z
      .object({
        backups: z
          .array(
            z
              .object({
                path: AbsPath,
                maxAgeHours: z
                  .number()
                  .min(1)
                  .max(24 * 366)
                  .optional(),
                restoreTest: z.boolean().optional(),
              })
              .strict(),
          )
          .max(32)
          .optional(),
        secretScanRoots: z.array(AbsPath).max(64).optional(),
        allowedPorts: z.array(z.number().int().min(1).max(65_535)).max(256).optional(),
        credentialWarnDays: z.number().int().min(1).max(365).optional(),
      })
      .strict()
      .optional(),
    siem: z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65_535),
        protocol: z.enum(["tcp", "tls", "udp"]).optional(),
        format: z.enum(["rfc5424", "cef"]).optional(),
        ca: AbsPath.optional(),
      })
      .strict()
      .optional(),
    advisories: z
      .object({
        feeds: z
          .array(z.enum(["jpcert", "ipa"]))
          .max(2)
          .optional(),
        products: z.array(z.string().min(1).max(120)).max(200).optional(),
      })
      .strict()
      .optional(),
    exposure: ExposureSchema.optional(),
  })
  .strict()
  .optional();
