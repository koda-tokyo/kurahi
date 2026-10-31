import { describe, expect, it } from "vitest";
import { GuardianSchema, isAbsoluteConfigPath } from "./zod-schema.guardian.js";

describe("guardian config paths", () => {
  it("accepts POSIX, Windows drive and UNC absolute paths only", () => {
    for (const p of ["/srv/share", "C:\\Shares\\Finance", "d:/backup", "\\\\nas01\\finance"]) {
      expect(isAbsoluteConfigPath(p)).toBe(true);
    }
    for (const p of ["share", "./share", "..\\x", "C:share", "\\share", "\\\\nas01", "~/x"]) {
      expect(isAbsoluteConfigPath(p)).toBe(false);
    }
  });

  it.each([
    ["shares", { shares: ["relative/share"] }],
    ["yaraRules", { scan: { yaraRules: "rules" } }],
    ["quarantine.dir", { scan: { quarantine: { dir: "q" } } }],
    ["backups", { posture: { backups: [{ path: "backup" }] } }],
    ["secretScanRoots", { posture: { secretScanRoots: ["docs"] } }],
    ["siem.ca", { siem: { host: "siem.example", port: 6514, ca: "ca.pem" } }],
  ])("refuses a relative %s", (_field, cfg) => {
    expect(GuardianSchema.safeParse(cfg).success).toBe(false);
  });

  it("accepts absolute paths everywhere", () => {
    const ok = GuardianSchema.safeParse({
      shares: ["/srv/share", "\\\\nas01\\finance"],
      scan: { yaraRules: "/etc/yara", quarantine: { dir: "C:\\Kurahi\\q" } },
      posture: { backups: [{ path: "/backup" }], secretScanRoots: ["/srv/share"] },
      siem: { host: "siem.example", port: 6514, ca: "/etc/ssl/ca.pem" },
    });
    expect(ok.success).toBe(true);
  });
});

describe("guardian exposure config", () => {
  const parse = (exposure: unknown) => GuardianSchema.safeParse({ exposure }).success;

  it("accepts lowercase apex domains and the documented options", () => {
    expect(
      parse({
        enabled: true,
        domains: ["example.co.jp", "xn--eckwd4c7c.xn--zckzah", "my-company.com"],
        emailDomains: ["example.co.jp"],
        brandTerms: ["Example Corp"],
        crawl: { maxPages: 200, maxBytes: 10_000_000, maxDepth: 3 },
        lookalikes: { max: 300, ignore: ["examp1e.co.jp"] },
        hibp: { enabled: true },
        github: { enabled: false },
        people: {
          enabled: true,
          retentionDays: 30,
          platforms: ["github"],
          hibp: { enabled: true },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["uppercase", "Example.com"],
    ["wildcard", "*.example.com"],
    ["scheme", "https://example.com"],
    ["path", "example.com/login"],
    ["trailing dot", "example.com."],
    ["single label", "localhost"],
    ["leading hyphen", "-example.com"],
    ["ip address", "192.168.0.1"],
  ])("refuses a domain with %s", (_why, domain) => {
    expect(parse({ domains: [domain] })).toBe(false);
  });

  it("caps domains at 20 and people platforms at 15", () => {
    const many = Array.from({ length: 21 }, (_, i) => `d${i}.example.com`);
    expect(parse({ domains: many })).toBe(false);
    expect(parse({ domains: many.slice(0, 20) })).toBe(true);
    const platforms = Array.from({ length: 16 }, (_, i) => `p${i}x`);
    expect(parse({ people: { platforms } })).toBe(false);
  });

  it("refuses unknown keys (no free-text person search)", () => {
    expect(parse({ domains: ["example.com"], people: { names: ["Taro Yamada"] } })).toBe(false);
    expect(parse({ domains: ["example.com"], usernames: ["taro"] })).toBe(false);
  });
});
