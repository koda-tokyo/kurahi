import { describe, expect, it } from "vitest";
import { KoLoSchema } from "../../config/zod-schema.js";
import { resolveTerminalSettings, TERMINAL_DEFAULTS } from "./settings.js";

describe("console.terminal settings", () => {
  it("is off by default", () => {
    const s = resolveTerminalSettings({});
    expect(s.enabled).toBe(false);
    expect(s.actApprovals).toBe("policy");
    expect(s.sandbox).toBe("off");
    expect(s.allowInteractive.size).toBe(0);
    expect(s.maxLineLength).toBe(TERMINAL_DEFAULTS.maxLineLength);
  });

  it("the config schema accepts the keys and rejects unknown ones or program paths", () => {
    const ok = KoLoSchema.safeParse({
      console: {
        terminal: {
          enabled: true,
          actApprovals: "always",
          sandbox: "required",
          allowInteractive: ["python3"],
          maxSessionsPerProject: 2,
          idleTimeoutMs: 60_000,
        },
      },
    });
    expect(ok.success).toBe(true);
    expect(KoLoSchema.safeParse({ console: { terminal: { shell: "/bin/zsh" } } }).success).toBe(
      false,
    );
    expect(
      KoLoSchema.safeParse({ console: { terminal: { allowInteractive: ["/usr/bin/vim"] } } })
        .success,
    ).toBe(false);
    expect(KoLoSchema.safeParse({ console: { terminal: { actApprovals: "never" } } }).success).toBe(
      false,
    );
  });
});
