import type { Command } from "commander";
import type { KoLoConfig } from "../../config/config.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { buildParseArgv, getPrimaryCommand, hasHelpOrVersion } from "../argv.js";
import { resolveActionArgs } from "./helpers.js";

type SubCliRegistrar = (program: Command) => Promise<void> | void;

type SubCliEntry = {
  name: string;
  description: string;
  register: SubCliRegistrar;
};

const shouldRegisterPrimaryOnly = (argv: string[]) => {
  if (isTruthyEnvValue(process.env.KOLO_DISABLE_LAZY_SUBCOMMANDS)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  return true;
};

const shouldEagerRegisterSubcommands = (_argv: string[]) => {
  return isTruthyEnvValue(process.env.KOLO_DISABLE_LAZY_SUBCOMMANDS);
};

const loadConfig = async (): Promise<KoLoConfig> => {
  const mod = await import("../../config/config.js");
  return mod.loadConfig();
};

const entries: SubCliEntry[] = [
  {
    name: "acp",
    description: "Agent Control Protocol tools",
    register: async (program) => {
      const mod = await import("../acp-cli.js");
      mod.registerAcpCli(program);
    },
  },
  {
    name: "api",
    description: "Call the gateway API (OpenAPI operations, WebSocket methods)",
    register: async (program) => {
      const mod = await import("../api-cli.js");
      mod.registerApiCli(program);
    },
  },
  {
    name: "pair",
    description: "Scoped device pairing (invitations, device credentials)",
    register: async (program) => {
      const mod = await import("../pair-cli.js");
      mod.registerPairCli(program);
    },
  },
  {
    name: "mcp",
    description: "MCP client servers (list, add, remove, test)",
    register: async (program) => {
      const mod = await import("../mcp-cli.js");
      mod.registerMcpCli(program);
    },
  },
  {
    name: "legacy",
    description: "Legacy analyser MCP server for engineers' own tools",
    register: async (program) => {
      const mod = await import("../legacy-cli.js");
      mod.registerLegacyCli(program);
    },
  },
  {
    name: "attach",
    description: "Attach this terminal to a live session",
    register: async (program) => {
      const mod = await import("../attach-cli.js");
      mod.registerAttachCli(program);
    },
  },
  {
    name: "gateway",
    description: "Gateway control",
    register: async (program) => {
      const mod = await import("../gateway-cli.js");
      mod.registerGatewayCli(program);
    },
  },
  {
    name: "daemon",
    description: "Gateway service (legacy alias)",
    register: async (program) => {
      const mod = await import("../daemon-cli.js");
      mod.registerDaemonCli(program);
    },
  },
  {
    name: "service",
    description: "Gateway OS service (systemd / launchd / Task Scheduler)",
    register: async (program) => {
      const mod = await import("../service-cli.js");
      mod.registerServiceCli(program);
    },
  },
  {
    name: "secrets",
    description: "Encrypted secrets store",
    register: async (program) => {
      const mod = await import("../secrets-cli.js");
      mod.registerSecretsCli(program);
    },
  },
  {
    name: "integrity",
    description: "Boot integrity registry (protected policy files)",
    register: async (program) => {
      const mod = await import("../integrity-cli.js");
      mod.registerIntegrityCli(program);
    },
  },
  {
    name: "continuity",
    description: "Proven continuity of a resident (run, verify, badge)",
    register: async (program) => {
      const mod = await import("../continuity-cli.js");
      mod.registerContinuityCli(program);
    },
  },
  {
    name: "evidence",
    description: "Evidence bundles and replay (list, show, export, verify, replay, prune)",
    register: async (program) => {
      const mod = await import("../evidence-cli.js");
      mod.registerEvidenceCli(program);
    },
  },
  {
    name: "eval",
    description: "Workflow Evaluator: acceptance specs, offline replay and signed scorecards",
    register: async (program) => {
      const mod = await import("../eval-cli.js");
      mod.registerEvalCli(program);
    },
  },
  {
    name: "inventory",
    description: "AI inventory: agents, models, tools, policy, MCP servers, channels",
    register: async (program) => {
      const mod = await import("../inventory-cli.js");
      mod.registerInventoryCli(program);
    },
  },
  {
    name: "policy",
    description: "Policy as code: one signed policy.yaml enforced for every resident",
    register: async (program) => {
      const mod = await import("../policy-cli.js");
      mod.registerPolicyCli(program);
    },
  },
  {
    name: "factory",
    description: "The factory: boards, cards, engine runs and pull requests",
    register: async (program) => {
      const mod = await import("../factory-cli.js");
      mod.registerFactoryCli(program);
    },
  },
  {
    name: "audit",
    description: "Hash-chained audit log (verify, tail)",
    register: async (program) => {
      const mod = await import("../audit-cli.js");
      mod.registerAuditCli(program);
    },
  },
  {
    name: "logs",
    description: "Gateway logs",
    register: async (program) => {
      const mod = await import("../logs-cli.js");
      mod.registerLogsCli(program);
    },
  },
  {
    name: "debug",
    description: "Diagnostics for a running gateway (CPU / heap profiles)",
    register: async (program) => {
      const mod = await import("../debug-cli.js");
      mod.registerDebugCli(program);
    },
  },
  {
    name: "system",
    description: "System events, heartbeat, and presence",
    register: async (program) => {
      const mod = await import("../system-cli.js");
      mod.registerSystemCli(program);
    },
  },
  {
    name: "models",
    description: "Model configuration",
    register: async (program) => {
      const mod = await import("../models-cli.js");
      mod.registerModelsCli(program);
    },
  },
  {
    name: "providers",
    description: "Model providers (registry, keys, probes)",
    register: async (program) => {
      const mod = await import("../providers-cli.js");
      mod.registerProvidersCli(program);
    },
  },
  {
    name: "approvals",
    description: "Exec approvals",
    register: async (program) => {
      const mod = await import("../exec-approvals-cli.js");
      mod.registerExecApprovalsCli(program);
    },
  },
  {
    name: "nodes",
    description: "Node commands",
    register: async (program) => {
      const mod = await import("../nodes-cli.js");
      mod.registerNodesCli(program);
    },
  },
  {
    name: "devices",
    description: "Device pairing + token management",
    register: async (program) => {
      const mod = await import("../devices-cli.js");
      mod.registerDevicesCli(program);
    },
  },
  {
    name: "node",
    description: "Node control",
    register: async (program) => {
      const mod = await import("../node-cli.js");
      mod.registerNodeCli(program);
    },
  },
  {
    name: "sandbox",
    description: "Sandbox tools",
    register: async (program) => {
      const mod = await import("../sandbox-cli.js");
      mod.registerSandboxCli(program);
    },
  },
  {
    name: "tui",
    description: "Terminal UI",
    register: async (program) => {
      const mod = await import("../tui-cli.js");
      mod.registerTuiCli(program);
    },
  },
  {
    name: "cron",
    description: "Cron scheduler",
    register: async (program) => {
      const mod = await import("../cron-cli.js");
      mod.registerCronCli(program);
    },
  },
  {
    name: "dns",
    description: "DNS helpers",
    register: async (program) => {
      const mod = await import("../dns-cli.js");
      mod.registerDnsCli(program);
    },
  },
  {
    name: "docs",
    description: "Docs helpers",
    register: async (program) => {
      const mod = await import("../docs-cli.js");
      mod.registerDocsCli(program);
    },
  },
  {
    name: "hooks",
    description: "Hooks tooling",
    register: async (program) => {
      const mod = await import("../hooks-cli.js");
      mod.registerHooksCli(program);
    },
  },
  {
    name: "webhooks",
    description: "Webhook helpers",
    register: async (program) => {
      const mod = await import("../webhooks-cli.js");
      mod.registerWebhooksCli(program);
    },
  },
  {
    name: "pairing",
    description: "Pairing helpers",
    register: async (program) => {
      // Initialize plugins before registering pairing CLI.
      // The pairing CLI calls listPairingChannels() at registration time,
      // which requires the plugin registry to be populated with channel plugins.
      const { registerPluginCliCommands } = await import("../../plugins/cli.js");
      registerPluginCliCommands(program, await loadConfig());
      const mod = await import("../pairing-cli.js");
      mod.registerPairingCli(program);
    },
  },
  {
    name: "plugins",
    description: "Plugin management",
    register: async (program) => {
      const mod = await import("../plugins-cli.js");
      mod.registerPluginsCli(program);
      const { registerPluginCliCommands } = await import("../../plugins/cli.js");
      registerPluginCliCommands(program, await loadConfig());
    },
  },
  {
    name: "connect",
    description: "Connect your phone (WhatsApp, Telegram, LINE, phone browser)",
    register: async (program) => {
      const mod = await import("../connect-cli.js");
      mod.registerConnectCli(program);
    },
  },
  {
    name: "channels",
    description: "Channel management",
    register: async (program) => {
      const mod = await import("../channels-cli.js");
      mod.registerChannelsCli(program);
    },
  },
  {
    name: "directory",
    description: "Directory commands",
    register: async (program) => {
      const mod = await import("../directory-cli.js");
      mod.registerDirectoryCli(program);
    },
  },
  {
    name: "security",
    description: "Security helpers",
    register: async (program) => {
      const mod = await import("../security-cli.js");
      mod.registerSecurityCli(program);
    },
  },
  {
    name: "skills",
    description: "Skills management",
    register: async (program) => {
      const mod = await import("../skills-cli.js");
      mod.registerSkillsCli(program);
    },
  },
  {
    name: "update",
    description: "CLI update helpers",
    register: async (program) => {
      const mod = await import("../update-cli.js");
      mod.registerUpdateCli(program);
    },
  },
  {
    name: "completion",
    description: "Generate shell completion script",
    register: async (program) => {
      const mod = await import("../completion-cli.js");
      mod.registerCompletionCli(program);
    },
  },
];

export function getSubCliEntries(): SubCliEntry[] {
  return entries;
}

function removeCommand(program: Command, command: Command) {
  const commands = program.commands as Command[];
  const index = commands.indexOf(command);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

export async function registerSubCliByName(program: Command, name: string): Promise<boolean> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    return false;
  }
  const existing = program.commands.find((cmd) => cmd.name() === entry.name);
  if (existing) {
    removeCommand(program, existing);
  }
  await entry.register(program);
  return true;
}

function registerLazyCommand(program: Command, entry: SubCliEntry) {
  const placeholder = program.command(entry.name).description(entry.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    removeCommand(program, placeholder);
    await entry.register(program);
    const actionCommand = actionArgs.at(-1) as Command | undefined;
    const root = actionCommand?.parent ?? program;
    const rawArgs = (root as Command & { rawArgs?: string[] }).rawArgs;
    const actionArgsList = resolveActionArgs(actionCommand);
    const fallbackArgv = actionCommand?.name()
      ? [actionCommand.name(), ...actionArgsList]
      : actionArgsList;
    const parseArgv = buildParseArgv({
      programName: program.name(),
      rawArgs,
      fallbackArgv,
    });
    await program.parseAsync(parseArgv);
  });
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  if (shouldEagerRegisterSubcommands(argv)) {
    for (const entry of entries) {
      void entry.register(program);
    }
    return;
  }
  const primary = getPrimaryCommand(argv);
  if (primary && shouldRegisterPrimaryOnly(argv)) {
    const entry = entries.find((candidate) => candidate.name === primary);
    if (entry) {
      registerLazyCommand(program, entry);
      return;
    }
  }
  for (const candidate of entries) {
    registerLazyCommand(program, candidate);
  }
}
