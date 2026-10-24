// Program tables for the console terminal's line gate (src/console/terminal/classify.ts).
// Names are matched on the basename of the program word. A program missing from every table is
// "runs-program": the gate cannot tell what it does, so it is never read-only.

/** Programs that only read (given the flag checks in classify.ts). */
export const READ_ONLY_PROGRAMS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "echo",
  "printf",
  "which",
  "whoami",
  "id",
  "groups",
  "uname",
  "diff",
  "cmp",
  "comm",
  "cut",
  "tr",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
  "column",
  "nl",
  "od",
  "hexdump",
  "strings",
  "paste",
  "fold",
  "fmt",
  "rev",
  "tac",
  "seq",
  "expr",
  "true",
  "false",
  "test",
  "[",
  "sleep",
  "ps",
  "free",
  "uptime",
  "locale",
  "tty",
  "type",
  "find",
  "sort",
  "uniq",
  "date",
  "hostname",
  // Print the environment: read-only, and their output has every value redacted.
  "env",
  "printenv",
]);

/** Flags that make an otherwise read-only program write, run programs or change state. */
export const READ_ONLY_FLAG_EXCEPTIONS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output(=.*)?|--compress-program(=.*)?)$|^-[a-zA-Z]*o/,
  rg: /^(--pre(=.*)?|--pre-glob(=.*)?)$/,
  tree: /^(-o|-R)$/,
  date: /^(-s|--set(=.*)?)$/,
};

/** Builtins and programs that print the environment (values are redacted in their output). */
export const ENV_PRINTERS = new Set(["env", "printenv", "set", "export", "declare", "typeset"]);

/** Wrappers whose real command follows their own options. */
export const WRAPPERS = new Set([
  "env",
  "nice",
  "ionice",
  "nohup",
  "time",
  "timeout",
  "stdbuf",
  "command",
  "builtin",
  "exec",
]);

/** Wrapper options that take a value (`timeout -s KILL 5 cmd`, `nice -n 5 cmd`). */
export const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "--class", "--classdata"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
};

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);

/** Interpreters: interactive without a script, a `-c`/`-e` program, or a module. */
export const INTERPRETERS = new Set([
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "bun",
  "ruby",
  "irb",
  "perl",
  "php",
  "lua",
  "R",
  "Rscript",
  "julia",
  "ghci",
  "scala",
  "clojure",
  "pwsh",
]);

/** Always interactive (full-screen or prompt-driven). */
export const INTERACTIVE_PROGRAMS = new Set([
  "vi",
  "vim",
  "nvim",
  "view",
  "nano",
  "pico",
  "emacs",
  "micro",
  "joe",
  "ed",
  "less",
  "more",
  "most",
  "man",
  "info",
  "top",
  "htop",
  "btop",
  "atop",
  "watch",
  "ssh",
  "telnet",
  "ftp",
  "sftp",
  "mosh",
  "tmux",
  "screen",
  "mc",
  "ranger",
  "nnn",
  "vifm",
  "fzf",
  "gdb",
  "lldb",
  "pdb",
  "script",
  "expect",
  "irb",
  "ghci",
]);

/** Database clients: interactive unless the command is given on the line. */
export const DB_CLIENTS: Record<string, RegExp> = {
  psql: /^(-c|--command(=.*)?|-f|--file(=.*)?)$/,
  mysql: /^(-e|--execute(=.*)?)$/,
  mariadb: /^(-e|--execute(=.*)?)$/,
  sqlite3: /^-cmd$/,
  "redis-cli": /^$/,
  mongosh: /^(--eval|-f|--file)$/,
};

export const PRIVILEGE_PROGRAMS = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "runas",
  "run0",
  "chroot",
  "nsenter",
  "unshare",
]);

/** Programs that start work outside the session's process group or after it ends. */
export const DETACH_PROGRAMS = new Set([
  "setsid",
  "disown",
  "daemonize",
  "at",
  "batch",
  "crontab",
  "systemd-run",
]);

export const UNSUPPORTED_BUILTINS = new Set(["pushd", "popd", "dirs", "bg", "fg", "jobs"]);

export const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash"]);
export const PERMISSION_PROGRAMS = new Set(["chmod", "chown", "chgrp", "chattr", "setfacl"]);
export const WRITE_PROGRAMS = new Set([
  "cp",
  "install",
  "ln",
  "mkdir",
  "touch",
  "mkfifo",
  "mknod",
  "tee",
  "patch",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "xz",
  "unxz",
  "bzip2",
  "bunzip2",
  "split",
  "csplit",
  "sed",
  "awk",
  "gawk",
  "perl",
]);
export const OVERWRITE_PROGRAMS = new Set(["truncate", "dd"]);
export const PROCESS_PROGRAMS = new Set([
  "kill",
  "killall",
  "pkill",
  "systemctl",
  "service",
  "launchctl",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
]);
export const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "ping",
  "dig",
  "nslookup",
  "host",
  "whois",
  "aria2c",
  "http",
  "https",
]);

/** Package managers: subcommands that install (and download) packages. */
export const PACKAGE_INSTALL: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "ci", "update", "upgrade", "uninstall", "remove", "exec"]),
  pnpm: new Set(["install", "i", "add", "update", "up", "remove", "rm", "dlx", "exec"]),
  yarn: new Set(["install", "add", "upgrade", "remove", "dlx"]),
  bun: new Set(["install", "i", "add", "update", "remove", "x"]),
  pip: new Set(["install", "uninstall", "download"]),
  pip3: new Set(["install", "uninstall", "download"]),
  pipx: new Set(["install", "run", "upgrade"]),
  uv: new Set(["pip", "add", "sync", "tool", "run"]),
  poetry: new Set(["install", "add", "update", "remove"]),
  conda: new Set(["install", "create", "update", "remove"]),
  gem: new Set(["install", "update", "uninstall"]),
  cargo: new Set(["install", "add", "update"]),
  go: new Set(["install", "get"]),
  apt: new Set(["install", "remove", "purge", "upgrade"]),
  "apt-get": new Set(["install", "remove", "purge", "upgrade", "dist-upgrade"]),
  dnf: new Set(["install", "remove", "upgrade"]),
  yum: new Set(["install", "remove", "update"]),
  brew: new Set(["install", "uninstall", "upgrade", "reinstall"]),
  apk: new Set(["add", "del", "upgrade"]),
  pacman: new Set(["-S", "-R", "-U", "-Syu"]),
  composer: new Set(["install", "require", "update", "remove"]),
};

/** Always download-and-run. */
export const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

export const GIT_HISTORY_SUBCOMMANDS = new Set([
  "rebase",
  "filter-branch",
  "filter-repo",
  "replace",
  "reflog",
  "gc",
  "prune",
  "update-ref",
]);
export const GIT_NETWORK_SUBCOMMANDS = new Set([
  "push",
  "pull",
  "fetch",
  "clone",
  "ls-remote",
  "submodule",
  "remote",
]);
export const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "shortlog",
  "cat-file",
  "grep",
  "help",
  "version",
]);

/**
 * Environment names that change which program runs or what it loads. A line that assigns one
 * (prefix assignment or `export`) is never read-only.
 */
export const DANGEROUS_ENV_RE =
  /^(PATH|LD_[A-Z_]*|DYLD_[A-Z_]*|BASH_ENV|ENV|IFS|CDPATH|PROMPT_COMMAND|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|RUBYLIB|RUBYOPT|PERL5LIB|PERL5OPT|GIT_[A-Z_]*|HOME|SHELLOPTS|BASHOPTS|LESSOPEN|PAGER|EDITOR|VISUAL)$/;
