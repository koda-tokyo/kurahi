// Output redaction for the console terminal. Everything a session shows or exports passes
// through here: secret patterns (src/logging/redact.ts, the same set the logs and the audit log
// use), the exact values of the gateway's own secret environment variables, and, for lines that
// print the environment (`env`, `printenv`, `export -p`), every variable's value.
//
// Output is redacted line by line: a partial line is held back until its newline or until the
// session flushes it (prompts without a newline). A secret split across a flush is a known limit.

import { redactSensitiveText } from "../../logging/redact.js";

export const REDACTED = "[redacted]";
const HOLD_MAX = 4096;
const MIN_SECRET_LENGTH = 8;
const SECRET_ENV_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|COOKIE|SESSION|AUTH)/i;
// `NAME=value`, `declare -x NAME="value"`, `export NAME=value`, `setenv NAME value`.
const ENV_LINE_RE =
  /^(\s*(?:declare -[a-zA-Z-]+ |export |typeset -[a-zA-Z]+ )?)([A-Za-z_][A-Za-z0-9_]*)(=)(.*?)(\r?)$/;

/** Values of the gateway process's secret-named environment variables (never sent anywhere). */
export function collectSecretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (
      typeof value === "string" &&
      value.length >= MIN_SECRET_LENGTH &&
      SECRET_ENV_NAME_RE.test(name)
    ) {
      out.add(value);
    }
  }
  return [...out].toSorted((a, b) => b.length - a.length);
}

export class TextRedactor {
  constructor(private readonly secretValues: readonly string[] = []) {}

  /** Redact one piece of text; `envValues` also blanks every `NAME=value` line's value. */
  redact(text: string, envValues = false): string {
    let out = text;
    for (const value of this.secretValues) {
      if (out.includes(value)) {
        out = out.split(value).join(REDACTED);
      }
    }
    if (envValues) {
      out = out
        .split("\n")
        .map((line) =>
          line.replace(
            ENV_LINE_RE,
            (_m, pre, name, eq, _v, cr) => `${pre}${name}${eq}${REDACTED}${cr}`,
          ),
        )
        .join("\n");
    }
    return redactSensitiveText(out, { mode: "tools" });
  }
}

/** Streaming wrapper: holds the partial last line so patterns see whole lines. */
export class StreamRedactor {
  private held = "";
  envValues = false;

  constructor(private readonly redactor: TextRedactor) {}

  push(chunk: string): string {
    const text = this.held + chunk;
    const nl = text.lastIndexOf("\n");
    if (nl < 0) {
      if (text.length > HOLD_MAX) {
        this.held = "";
        return this.redactor.redact(text, this.envValues);
      }
      this.held = text;
      return "";
    }
    this.held = text.slice(nl + 1);
    const ready = text.slice(0, nl + 1);
    if (this.held.length > HOLD_MAX) {
      const rest = this.held;
      this.held = "";
      return this.redactor.redact(ready + rest, this.envValues);
    }
    return this.redactor.redact(ready, this.envValues);
  }

  flush(): string {
    const text = this.held;
    this.held = "";
    return text ? this.redactor.redact(text, this.envValues) : "";
  }
}
