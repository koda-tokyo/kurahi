import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { flushAudit } from "../audit/audit-log.js";
import { isDemoProfile, resolveReleaseProfile } from "../packaging/release-profile.js";
import { guardOutboundCall, wrapToolWithPersonalDataGuard } from "./outbound-guard.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-demo-outbound-"));
const home = path.join(root, "state");
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = home;
process.env.KOLO_STATE_DIR = home;

afterAll(() => {
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  fs.rmSync(root, { recursive: true, force: true });
});

const DEMO = { KURAHI_DEMO: "1" };

describe("demo profile", () => {
  it("is on only for an explicit KURAHI_DEMO and always runs as enterprise", () => {
    expect(isDemoProfile({})).toBe(false);
    expect(isDemoProfile({ KURAHI_DEMO: "0" })).toBe(false);
    expect(isDemoProfile({ KURAHI_DEMO: "" })).toBe(false);
    expect(isDemoProfile({ KURAHI_DEMO: "1" })).toBe(true);
    expect(isDemoProfile({ KURAHI_DEMO: " TRUE " })).toBe(true);
    expect(resolveReleaseProfile({}, DEMO)).toBe("enterprise");
    expect(resolveReleaseProfile({}, { KURAHI_PROFILE: "standard", ...DEMO })).toBe("enterprise");
  });

  it("refuses every outbound tool, even with clean arguments, and audits the refusal", async () => {
    const check = guardOutboundCall({
      toolName: "m365_mail_send",
      args: { to: ["a@example.com"], subject: "見積書", body: "ご確認ください" },
      agentId: "main",
      config: {} as KoLoConfig,
      home,
      env: DEMO,
    });
    expect(check.action).toBe("block");
    expect(check.action === "block" && check.reason).toMatch(/demo/i);
    await flushAudit();
    const auditText = fs
      .readdirSync(path.join(home, "audit"))
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => fs.readFileSync(path.join(home, "audit", n), "utf8"))
      .join("\n");
    expect(auditText).toContain("governance.demo.outboundRefused");
    expect(auditText).not.toContain("a@example.com");
  });

  it("leaves non-outbound tools and the standard profile alone", () => {
    const base = { args: { body: "hello" }, config: {} as KoLoConfig, home };
    expect(guardOutboundCall({ ...base, toolName: "read", env: DEMO }).action).toBe("allow");
    expect(guardOutboundCall({ ...base, toolName: "m365_mail_send", env: {} }).action).toBe(
      "allow",
    );
  });

  it("stops the wrapped agent tool before it runs", async () => {
    const prev = process.env.KURAHI_DEMO;
    process.env.KURAHI_DEMO = "1";
    try {
      let ran = false;
      const tool = wrapToolWithPersonalDataGuard(
        {
          name: "lineworks_message_send",
          execute: async () => {
            ran = true;
            return { ok: true };
          },
        },
        { agentId: "main", config: {} as KoLoConfig },
      );
      await expect(tool.execute("call-1", { text: "hi" } as never)).rejects.toThrow(/demo/i);
      expect(ran).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.KURAHI_DEMO;
      } else {
        process.env.KURAHI_DEMO = prev;
      }
    }
  });
});
