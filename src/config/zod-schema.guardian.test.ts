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
