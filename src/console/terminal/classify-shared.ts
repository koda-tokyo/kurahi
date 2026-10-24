// Shared pieces of the console terminal line classifier: the risk collector and word helpers.
import type { TerminalNoticeCode, TerminalRisk, TerminalRiskCode } from "./codes.js";
import type { ShellWord } from "./shell-words.js";

/** Most severe first: the approval shows the first one as `risk`. */
export const SEVERITY: TerminalRiskCode[] = [
  "read-only-path",
  "deletes-files",
  "rewrites-git-history",
  "overwrites-files",
  "changes-permissions",
  "installs-packages",
  "network",
  "process-control",
  "moves-files",
  "writes-files",
  "modifies-git-repository",
  "runs-nested-command",
  "runs-program",
  "background-job",
  "prints-environment",
  "outside-allowlist",
];

export type Refusal = { code: TerminalNoticeCode; params?: Record<string, string | number> };

export type LineClass = {
  refusal: Refusal | null;
  readOnly: boolean;
  risks: TerminalRisk[];
  /** The line prints environment values: its output is redacted value by value. */
  printsEnv: boolean;
  /** Programs named on the line (basenames), in order. */
  programs: string[];
};

export type ClassifyOptions = {
  /** Program names allowed to run interactively (config `allowInteractive`). */
  allowInteractive?: ReadonlySet<string>;
  /** Count the files a delete/write operand list names (globs expanded, `-r` walked). */
  countTargets?: (operands: ShellWord[], recursive: boolean) => number;
  /** True when a redirection or copy target already exists as a file. */
  fileExists?: (word: ShellWord) => boolean;
};

export class Collector {
  readOnly = true;
  printsEnv = false;
  refusal: Refusal | null = null;
  programs: string[] = [];
  private risks = new Map<TerminalRiskCode, TerminalRisk>();

  constructor(readonly opts: ClassifyOptions) {}

  risk(code: TerminalRiskCode, params?: Record<string, string | number>) {
    this.readOnly = false;
    const prev = this.risks.get(code);
    if (!prev) {
      this.risks.set(code, params ? { code, params: { ...params } } : { code });
      return;
    }
    const a = prev.params?.count;
    const b = params?.count;
    if (typeof a === "number" && typeof b === "number") {
      prev.params = { ...prev.params, count: a + b };
    }
  }

  refuse(code: TerminalNoticeCode, params?: Record<string, string | number>) {
    this.refusal ??= params ? { code, params } : { code };
  }

  sortedRisks(): TerminalRisk[] {
    return [...this.risks.values()].toSorted(
      (x, y) => SEVERITY.indexOf(x.code) - SEVERITY.indexOf(y.code),
    );
  }

  count(operands: ShellWord[], recursive = false): number {
    return this.opts.countTargets ? this.opts.countTargets(operands, recursive) : operands.length;
  }

  exists(word: ShellWord): boolean {
    return this.opts.fileExists?.(word) ?? false;
  }
}

export const isFlag = (w: ShellWord) => w.value.length > 1 && w.value.startsWith("-");

/** Operands after the program: words that are not flags (everything after `--`). */
export function operandsOf(args: ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  let flagsDone = false;
  for (const w of args) {
    if (!flagsDone && w.value === "--") {
      flagsDone = true;
      continue;
    }
    if (flagsDone || !isFlag(w)) {
      out.push(w);
    }
  }
  return out;
}

export const hasFlag = (args: ShellWord[], re: RegExp) => args.some((w) => re.test(w.value));
