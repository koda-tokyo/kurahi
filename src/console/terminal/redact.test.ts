import { describe, expect, it } from "vitest";
import { buildShellEnv } from "./pty-backend.js";
import { collectSecretEnvValues, REDACTED, StreamRedactor, TextRedactor } from "./redact.js";

describe("terminal redaction", () => {
  it("collects only secret-named gateway variables", () => {
    const values = collectSecretEnvValues({
      KOLO_GATEWAY_TOKEN: "a".repeat(32),
      OPENAI_API_KEY: "sk-proj-abcdefghijklmnop",
      HOME: "/home/someone-long-path",
      SHORT_TOKEN: "abc",
    });
    expect(values).toEqual(["a".repeat(32), "sk-proj-abcdefghijklmnop"]);
  });

  it("removes secret values and secret patterns from output", () => {
    const r = new TextRedactor(["gateway-secret-value-123"]);
    const out = r.redact(
      "token is gateway-secret-value-123\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n",
    );
    expect(out).not.toContain("gateway-secret-value-123");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("blanks every value of an environment listing", () => {
    const r = new TextRedactor();
    const out = r.redact(
      'HOME=/work/p\r\nLANG=C.UTF-8\r\ndeclare -x FOO="bar"\r\nplain text\r\n',
      true,
    );
    expect(out).toBe(
      `HOME=${REDACTED}\r\nLANG=${REDACTED}\r\ndeclare -x FOO=${REDACTED}\r\nplain text\r\n`,
    );
  });

  it("holds a partial line until its newline so a split secret is still found", () => {
    const s = new StreamRedactor(new TextRedactor(["split-secret-value"]));
    expect(s.push("start split-se")).toBe("");
    const out = s.push("cret-value end\nnext");
    expect(out).toBe(`start ${REDACTED} end\n`);
    expect(s.flush()).toBe("next");
  });

  // POSIX PATH semantics; the terminal broker does not run on Windows gateways.
  it.skipIf(process.platform === "win32")(
    "the shell environment is an allowlist without gateway secrets",
    () => {
      const env = buildShellEnv("/work/project", {
        PATH: "/usr/bin:relative/bin:/bin",
        OPENAI_API_KEY: "sk-should-not-pass",
        KOLO_GATEWAY_TOKEN: "x".repeat(40),
        LANG: "ja_JP.UTF-8",
      });
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.HOME).toBe("/work/project");
      expect(env.LANG).toBe("ja_JP.UTF-8");
      expect(env.EDITOR).toBe("false");
      expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
      expect(Object.keys(env)).not.toContain("KOLO_GATEWAY_TOKEN");
    },
  );
});
