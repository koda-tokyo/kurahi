// Starter policy written by `kurahi policy init` (KoLo 2.0, M13d). Documented line by line so a
// security team can read it as the specification it is; every section is optional.
export const STARTER_POLICY_YAML = `# KoLo policy — one declarative file, signed by an owner, enforced for every resident.
# Validate: kurahi policy validate      Sign: kurahi policy sign      Status: kurahi policy status
# Schema:   kurahi policy schema        Docs: see docs/policy
version: 1
name: starter
description: Secure defaults. Agents keep their config permissions; runaway jobs and spend are capped.

# Per agent (key = agent id glob). Later entries do not override earlier ones: every matching
# entry applies, deny wins over allow, and an allow list restricts to its union.
agents:
  "*":
    # Same syntax as agents.list[].permissions; these take precedence over the config rules.
    # permissions: ["read:**", "write:/workspace/**", "exec:git *"]
    tools:
      deny: []            # e.g. ["process", "gateway"]
      # allow: ["read", "write", "edit", "exec", "web_*", "mcp_*"]
    # providers: ["*"]    # model providers this agent may call
    # models: ["*"]       # provider/model refs
    # channels: ["*"]     # channels it may receive from and send to
    # Job limits (ASI08): at most 4 jobs at once per agent, 30 minutes and 200 tool steps per job.
    limits:
      maxConcurrentJobs: 4
      wallClockPerJobMs: 1800000
      maxSteps: 200

# Spend. Costs use the provider price tables in the config (models.providers[].models[].cost);
# a model without a price counts tokens only. onBreach: warn | pause | stop.
# A pause holds new work until the window resets or an operator runs \`kurahi policy release\`.
budgets:
  currency: USD
  resetHourUtc: 0
  fleet:
    tokensPerDay: 20000000
    toolCallsPerHour: 5000
    onBreach: pause
  agents:
    "*":
      tokensPerDay: 5000000
      toolCallsPerHour: 1200
      onBreach: pause

# Kill switch. The runtime switch (kurahi policy kill) is separate and survives restarts.
kill:
  fleet: false
  agents: []
  mayFlip: [owner, admin]

# Human approvals. Classes: exec | write | read | network | mcp | messaging | tool:<glob>.
approvals:
  # channel: "slack:#ops-approvals"
  timeoutMs: 120000
  require: []

# Egress for tools and MCP servers.
network:
  egress:
    deny: ["169.254.169.254", "metadata.google.internal"]
    # allow: ["*.example.com"]
  mcp:
    deny: []
    # allow: ["docs", "tickets"]

# Data never touched by any tool, and argument patterns that refuse a call.
data:
  neverRead: ["~/.ssh/**", "**/.env", "**/*.pem", "**/id_rsa*"]
  neverWrite: ["~/.ssh/**", "/etc/**"]
  secretPatterns:
    - "-----BEGIN [A-Z ]*PRIVATE KEY-----"
    - "AKIA[0-9A-Z]{16}"
  # Context guard: personal data in tool results becomes [[PII:KIND:n]] placeholders before the
  # model sees it; restoreTo lists tools that get the real values back. Uncomment to enable.
  # redact:
  #   fields: ["@personal"]
  #   restoreTo: ["message"]

# HTTP operationIds / WS methods refused for a credential scope.
requests:
  deny: []

# Ransomware shield: decoy files and mass-encryption detection stop every agent (default: stop).
shield:
  mode: stop

# Attestation: with required true (the default) an unsigned policy is refused in enforce mode.
attestation:
  required: true
`;

const NEVER_READ_LINE = `  neverRead: ["~/.ssh/**", "**/.env", "**/*.pem", "**/id_rsa*"]`;
const NEVER_WRITE_LINE = `  neverWrite: ["~/.ssh/**", "/etc/**"]`;

/**
 * The starter policy for one state directory. Besides the generic entries it keeps the agents'
 * own file tools away from the state directory's secrets (gateway token, owner signing key,
 * credential stores) and from the files that govern them (policy, config, audit log), so a
 * prompt-injected agent cannot read the owner key or rewrite its own policy with read/write/edit.
 * Exec is covered by approvals and the sandbox, not by these lists. A state directory whose path
 * contains glob characters gets the generic policy only (the entries would not match literally).
 * `extraSecretFiles` adds files kept elsewhere (an owner key moved out with
 * KOLO_POLICY_OWNER_KEY_FILE) to both lists.
 */
export function starterPolicyYaml(koloHome?: string, extraSecretFiles: string[] = []): string {
  if (!koloHome) {
    return STARTER_POLICY_YAML;
  }
  const home = koloHome.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!home || /[*?[\]{}!]/.test(home)) {
    return STARTER_POLICY_YAML;
  }
  const q = (p: string) => JSON.stringify(p);
  const extra = extraSecretFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f && !f.startsWith(`${home}/secrets/`) && !/[*?[\]{}!]/.test(f));
  const read = [`${home}/secrets/**`, ...extra];
  const write = [
    `${home}/secrets/**`,
    `${home}/policy/**`,
    `${home}/kolo.json`,
    `${home}/audit/**`,
    ...extra,
  ];
  return STARTER_POLICY_YAML.replace(
    NEVER_READ_LINE,
    `  neverRead: ["~/.ssh/**", "**/.env", "**/*.pem", "**/id_rsa*", ${read.map(q).join(", ")}]`,
  ).replace(
    NEVER_WRITE_LINE,
    `  # The state directory's secrets, policy, config and audit log are never touched by file tools.\n  neverWrite: ["~/.ssh/**", "/etc/**", ${write.map(q).join(", ")}]`,
  );
}
