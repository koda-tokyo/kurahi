import type { ShellWord } from "./shell-words.js";
import { type Collector, hasFlag, operandsOf } from "./classify-shared.js";
// Git subcommand risks for the console terminal line classifier.
import {
  GIT_HISTORY_SUBCOMMANDS,
  GIT_NETWORK_SUBCOMMANDS,
  GIT_READ_SUBCOMMANDS,
} from "./command-tables.js";

export function analyzeGit(args: ShellWord[], c: Collector) {
  let i = 0;
  while (i < args.length && args[i].value.startsWith("-")) {
    const v = args[i].value;
    if (v === "--exec-path" || v.startsWith("--exec-path=")) {
      c.risk("runs-program", { program: "git" });
    }
    i += v === "-C" || v === "-c" || v === "--git-dir" || v === "--work-tree" ? 2 : 1;
  }
  const sub = args[i]?.value ?? "";
  const rest = args.slice(i + 1);
  const flag = (re: RegExp) => hasFlag(rest, re);
  const g = { program: "git" };
  if (sub === "push") {
    c.risk("network", g);
    if (
      flag(/^(-f|--force|--force-with-lease(=.*)?|--mirror|--delete|-d)$/) ||
      rest.some((w) => w.value.startsWith("+"))
    ) {
      c.risk("rewrites-git-history", g);
    }
  } else if (GIT_NETWORK_SUBCOMMANDS.has(sub)) {
    if (sub === "remote") {
      const action = operandsOf(rest)[0]?.value;
      if (action === "update" || action === "prune") {
        c.risk("network", g);
      } else if (action && action !== "show" && action !== "get-url") {
        c.risk("modifies-git-repository", g);
      }
    } else {
      c.risk("network", g);
      if (sub !== "ls-remote") {
        c.risk("modifies-git-repository", g);
      }
    }
  } else if (sub === "reset") {
    c.risk(flag(/^--(hard|merge|keep)$/) ? "rewrites-git-history" : "modifies-git-repository", g);
  } else if (sub === "clean") {
    if (!flag(/^(-n|--dry-run)$/)) {
      c.risk("deletes-files", g);
    }
  } else if (sub === "checkout" || sub === "restore" || sub === "switch") {
    const discards =
      sub === "restore" ||
      flag(/^(-f|--force|--discard-changes|--)$/) ||
      rest.some((w) => w.value === ".");
    c.risk(discards ? "overwrites-files" : "modifies-git-repository", g);
  } else if (sub === "commit") {
    c.risk(flag(/^--amend$/) ? "rewrites-git-history" : "modifies-git-repository", g);
  } else if (sub === "branch" || sub === "tag") {
    if (flag(/^(-D|-d|--delete|-M|-f|--force)$/)) {
      c.risk("rewrites-git-history", g);
    } else if (operandsOf(rest).length > 0 || flag(/^(-m|-a)$/)) {
      c.risk("modifies-git-repository", g);
    }
  } else if (sub === "stash") {
    c.risk(
      rest[0]?.value === "drop" || rest[0]?.value === "clear"
        ? "rewrites-git-history"
        : "modifies-git-repository",
      g,
    );
  } else if (sub === "rm") {
    c.risk("deletes-files", { count: c.count(operandsOf(rest), flag(/^-r$/)) });
  } else if (GIT_HISTORY_SUBCOMMANDS.has(sub)) {
    c.risk("rewrites-git-history", g);
  } else if (sub === "config") {
    if (!flag(/^(--get|--get-all|--list|-l|--get-regexp)$/)) {
      c.risk("modifies-git-repository", g);
    }
  } else if (!GIT_READ_SUBCOMMANDS.has(sub)) {
    c.risk("modifies-git-repository", g);
  }
  // Never read-only: repository config can run programs on any command (core.fsmonitor,
  // filters, textconv, hooks), so even `git status` is approved like any other program.
  c.readOnly = false;
}
