// `kurahi init`: the first command on a new machine. Creates the state root, the gateway token
// file and a minimal config that lets `kurahi gateway` / `kurahi service install` start without
// further flags, runs the doctor report, and prints the next steps. Interactive by default,
// fully scriptable with --non-interactive.

import { confirm, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { RuntimeEnv } from "../runtime.js";
import type { ConnectDeps } from "./connect/types.js";
import { ensureAuthProfileStore, upsertAuthProfile } from "../agents/auth-profiles.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { installStarterPolicyIfAbsent } from "../cli/policy-cli-actions.js";
import { createConfigIO, type KoLoConfig, writeConfigFile } from "../config/config.js";
import { ensureKoloDir, koloSecretsDir, resolveKoloHome } from "../config/kolo-home.js";
import { resolveGatewayPort } from "../config/paths.js";
import { DOCS_URL } from "../config/product-urls.js";
import { applySecureDefaults, findLegacyDefaults } from "../config/secure-defaults.js";
import { defaultGatewayTokenFilePath, ensureGatewayTokenFile } from "../gateway/token-file.js";
import { t } from "../i18n/index.js";
import { RESIDENCIES, type Residency } from "../model-bench/catalogue.js";
import { resolvePolicyLocations } from "../policy/paths.js";
import { defaultRuntime } from "../runtime.js";
import { buildDoctorJsonReport } from "./doctor-json.js";
import { isDockerAvailable } from "./doctor-sandbox.js";
import { applyKodaTestedProfile } from "./init-koda-tested.js";
import {
  INIT_PHONE_CHOICES,
  type InitPhoneChoice,
  isInitPhoneChoice,
  runInitPhoneStep,
} from "./init-phone.js";
import { applyAuthProfileConfig, applySakuraConfig } from "./onboard-auth.config-core.js";
import { setSakuraApiKey } from "./onboard-auth.credentials.js";
import { SAKURA_DEFAULT_MODEL_REF } from "./onboard-auth.models.js";

/**
 * Who may reach the gateway. `loopback`, `lan`, `tailnet` and `custom` are the gateway bind modes;
 * `remote` is the plain-language alias for `lan`. Every non-loopback policy also sets
 * `gateway.remote.enabled`, without which the gateway refuses a non-loopback bind at startup.
 */
export type InitBindPolicy = "loopback" | "lan" | "tailnet" | "custom" | "remote";
export const INIT_BIND_POLICIES: readonly InitBindPolicy[] = [
  "loopback",
  "lan",
  "tailnet",
  "custom",
  "remote",
];

/** The `gateway.bind` value and whether `gateway.remote.enabled` must be set for a policy. */
export function resolveInitBind(policy: InitBindPolicy): {
  bind: "loopback" | "lan" | "tailnet" | "custom";
  remote: boolean;
} {
  if (policy === "loopback") {
    return { bind: "loopback", remote: false };
  }
  return { bind: policy === "remote" ? "lan" : policy, remote: true };
}
export type InitProviderProfile = "sakura" | "openai-compatible" | "local" | "koda-tested";

export const INIT_PROVIDER_PROFILES: Array<{
  value: InitProviderProfile;
  label: string;
  hint: string;
}> = [
  {
    value: "sakura",
    label: "Sakura AI Engine (Japan-hosted, OpenAI-compatible)",
    hint: "free tier 3,000 requests a month; token from https://secure.sakura.ad.jp/ai/",
  },
  {
    value: "openai-compatible",
    label: "Your own OpenAI-compatible endpoint",
    hint: "base URL + API key",
  },
  {
    value: "local",
    label: "Local model server (Ollama)",
    hint: "no key; models you pulled locally",
  },
  {
    value: "koda-tested",
    label: "KODA tested: the best benchmarked model you can run",
    hint: "uses keys already set on this machine; see kurahi models tested",
  },
];

export type InitOptions = {
  nonInteractive?: boolean;
  /** Identity name; also the service id. */
  name?: string;
  /** Overrides KOLO_HOME for this run and is printed as an export hint. */
  stateDir?: string;
  bind?: InitBindPolicy;
  /** Provider profile: sakura | openai-compatible | local | koda-tested; omitted = decide later. */
  provider?: InitProviderProfile;
  /** koda-tested: residency preference (jp | eu | us | cn | sg | local). */
  residency?: Residency;
  /** openai-compatible: base URL and model id; local: model id. Keys come from env or prompt. */
  providerBaseUrl?: string;
  providerModel?: string;
  json?: boolean;
  force?: boolean;
  /** Last step: connect a phone (whatsapp | telegram | line | web | skip); omitted = ask when interactive. */
  phone?: InitPhoneChoice;
};

const IDENTITY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateIdentityName(value: string): string | null {
  if (!IDENTITY_RE.test(value)) {
    return "use 1-32 lowercase letters, digits, '-' or '_', starting with a letter or digit";
  }
  return null;
}

function cancelled(): never {
  defaultRuntime.error(t("init.cancelled"));
  defaultRuntime.exit(1);
  throw new Error("unreachable");
}

async function askInteractive(defaults: Required<Pick<InitOptions, "name" | "bind">>) {
  intro("kurahi init");
  const name = await text({
    message: t("init.q.name"),
    initialValue: defaults.name,
    validate: (value) => validateIdentityName(String(value ?? "")) ?? undefined,
  });
  if (isCancel(name)) {
    cancelled();
  }
  const bind = await select({
    message: t("init.q.bind"),
    options: [
      { value: "loopback", label: t("init.q.bind.loopback"), hint: t("init.recommended") },
      { value: "remote", label: t("init.q.bind.remote") },
    ],
    initialValue: defaults.bind,
  });
  if (isCancel(bind)) {
    cancelled();
  }
  const providerChoice = await select({
    message: t("init.q.provider"),
    options: [
      ...INIT_PROVIDER_PROFILES.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
      {
        value: "later",
        label: t("init.q.provider.later"),
        hint: "kurahi onboard / kurahi secrets",
      },
    ],
    initialValue: "sakura",
  });
  if (isCancel(providerChoice)) {
    cancelled();
  }
  const provider = providerChoice === "later" ? undefined : (providerChoice as InitProviderProfile);
  let providerKey: string | undefined;
  let providerBaseUrl: string | undefined;
  let providerModel: string | undefined;
  let residency: Residency | undefined;
  if (provider === "sakura") {
    const key = await password({
      message: t("init.q.sakura.token"),
      validate: (v) => (String(v ?? "").trim().length < 8 ? "enter the token" : undefined),
    });
    if (isCancel(key)) {
      cancelled();
    }
    providerKey = String(key).trim();
  } else if (provider === "openai-compatible") {
    const url = await text({
      message: "Base URL (ends with /v1)",
      placeholder: "https://llm.example.com/v1",
    });
    if (isCancel(url)) {
      cancelled();
    }
    const key = await password({ message: "API key (leave empty if the endpoint needs none)" });
    if (isCancel(key)) {
      cancelled();
    }
    const model = await text({
      message: "Model id as the endpoint names it",
      placeholder: "my-model",
    });
    if (isCancel(model)) {
      cancelled();
    }
    providerBaseUrl = String(url).trim();
    providerKey = String(key ?? "").trim() || undefined;
    providerModel = String(model).trim();
  } else if (provider === "local") {
    const model = await text({
      message: "Model id as shown by `ollama list`",
      placeholder: "gpt-oss:20b",
      defaultValue: "gpt-oss:20b",
    });
    if (isCancel(model)) {
      cancelled();
    }
    providerModel = String(model).trim();
  } else if (provider === "koda-tested") {
    const region = await select({
      message: "Where may model requests be processed?",
      options: [
        { value: "any", label: "Anywhere" },
        { value: "jp", label: "Japan" },
        { value: "eu", label: "European Union" },
        { value: "us", label: "United States" },
        { value: "local", label: "This machine only" },
      ],
      initialValue: "any",
    });
    if (isCancel(region)) {
      cancelled();
    }
    residency = region === "any" ? undefined : (region as Residency);
  }
  const ok = await confirm({ message: t("init.q.confirm") });
  if (isCancel(ok) || !ok) {
    cancelled();
  }
  return {
    name: String(name),
    bind: bind as InitBindPolicy,
    provider,
    providerKey,
    providerBaseUrl,
    providerModel,
    residency,
  };
}

type ProviderAnswers = {
  residency?: Residency;
  provider?: InitProviderProfile;
  providerKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
};

/** Writes credentials to the auth store and the provider/model defaults into the config. */
async function applyInitProvider(
  cfg: KoLoConfig,
  a: ProviderAnswers,
  _home: string,
): Promise<{ config: KoLoConfig; summary: string }> {
  if (!a.provider) {
    return { config: cfg, summary: "not chosen (kurahi onboard, or kurahi secrets)" };
  }
  if (a.provider === "koda-tested") {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
    return applyKodaTestedProfile(cfg, { residency: a.residency }, { store });
  }
  if (a.provider === "sakura") {
    if (a.providerKey) {
      await setSakuraApiKey(a.providerKey);
    }
    let next = applySakuraConfig(cfg);
    next = applyAuthProfileConfig(next, {
      profileId: "sakura:default",
      provider: "sakura",
      mode: "api_key",
    });
    return {
      config: next,
      summary: `sakura (${SAKURA_DEFAULT_MODEL_REF}); token ${a.providerKey ? "stored" : "missing: set SAKURA_API_KEY and run kurahi init --provider sakura again"}`,
    };
  }
  if (a.provider === "openai-compatible") {
    const baseUrl = a.providerBaseUrl?.trim();
    const modelId = a.providerModel?.trim();
    if (!baseUrl || !modelId) {
      return {
        config: cfg,
        summary:
          "openai-compatible: base URL and model id required (--provider-base-url, --provider-model)",
      };
    }
    if (a.providerKey) {
      upsertAuthProfile({
        profileId: "openai-compatible:default",
        credential: { type: "api_key", provider: "openai-compatible", key: a.providerKey },
      });
    }
    const ref = `openai-compatible/${modelId}`;
    const providers = { ...cfg.models?.providers };
    providers["openai-compatible"] = {
      ...(providers["openai-compatible"] as object),
      baseUrl,
      api: "openai-completions",
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    } as (typeof providers)[string];
    let next: KoLoConfig = {
      ...cfg,
      models: { mode: cfg.models?.mode ?? "merge", providers },
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: { primary: ref } } },
    };
    if (a.providerKey) {
      next = applyAuthProfileConfig(next, {
        profileId: "openai-compatible:default",
        provider: "openai-compatible",
        mode: "api_key",
      });
    }
    return { config: next, summary: `openai-compatible (${ref}) at ${baseUrl}` };
  }
  const modelId = a.providerModel?.trim() || "gpt-oss:20b";
  const ref = `ollama/${modelId}`;
  return {
    config: {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: { primary: ref } } },
    },
    summary: `local (${ref}); the model server must be running on this machine`,
  };
}

export async function initCommand(
  opts: InitOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
  /** Test seam for the phone step. */
  phoneDeps?: ConnectDeps,
) {
  if (opts.stateDir) {
    const abs = path.resolve(opts.stateDir);
    process.env.KOLO_HOME = abs;
    process.env.KOLO_STATE_DIR = abs;
    delete process.env.KOLO_CONFIG_PATH;
  }
  const defaults = { name: opts.name ?? "default", bind: opts.bind ?? ("loopback" as const) };
  if (opts.name) {
    const problem = validateIdentityName(opts.name);
    if (problem) {
      runtime.error(`--name ${opts.name}: ${problem}`);
      runtime.exit(2);
      return;
    }
  }
  if (opts.bind && !INIT_BIND_POLICIES.includes(opts.bind)) {
    runtime.error(`--bind ${String(opts.bind)}: expected ${INIT_BIND_POLICIES.join(", ")}`);
    runtime.exit(2);
    return;
  }

  if (opts.phone !== undefined && !isInitPhoneChoice(opts.phone)) {
    runtime.error(`--phone ${String(opts.phone)}: expected ${INIT_PHONE_CHOICES.join(", ")}`);
    runtime.exit(2);
    return;
  }

  if (opts.residency && !RESIDENCIES.includes(opts.residency)) {
    runtime.error(`--residency ${String(opts.residency)}: expected ${RESIDENCIES.join(", ")}`);
    runtime.exit(2);
    return;
  }
  const interactive = !opts.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  if (opts.provider && !INIT_PROVIDER_PROFILES.some((p) => p.value === opts.provider)) {
    runtime.error(
      `--provider ${String(opts.provider)}: expected sakura, openai-compatible, local or koda-tested`,
    );
    runtime.exit(2);
    return;
  }
  const answers = interactive
    ? await askInteractive(defaults)
    : {
        name: defaults.name,
        bind: defaults.bind,
        provider: opts.provider,
        providerKey:
          opts.provider === "sakura"
            ? process.env.SAKURA_API_KEY?.trim() || undefined
            : process.env.KOLO_PROVIDER_API_KEY?.trim() || undefined,
        providerBaseUrl: opts.providerBaseUrl,
        providerModel: opts.providerModel,
        residency: opts.residency,
      };

  const home = ensureKoloDir(resolveKoloHome());
  const io = createConfigIO();
  const configPath = io.configPath;
  const existing = fs.existsSync(configPath);
  if (existing && !opts.force) {
    // Re-running init must never clobber a config someone edited. Merge, do not replace.
    runtime.log(t("init.exists", { path: configPath }));
  }

  let base: KoLoConfig = {};
  if (existing && !opts.force) {
    try {
      base = await io.loadConfig();
    } catch {
      base = {};
    }
  }
  // Under KOLO_HOME, never under a second "shared" home: one state root per identity.
  const workspace = base.agents?.defaults?.workspace ?? path.join(home, "workspace");
  // The identity is an agent entry: `agents.list[]` with the chosen id, default when it is the
  // only one. Re-running with the same name updates the entry in place.
  const list = [...(base.agents?.list ?? [])];
  const existingIdx = list.findIndex((agent) => agent.id === answers.name);
  const entry = {
    ...(existingIdx >= 0 ? list[existingIdx] : {}),
    id: answers.name,
    default:
      existingIdx >= 0 ? (list[existingIdx]?.default ?? list.length === 1) : list.length === 0,
    identity: { ...(existingIdx >= 0 ? list[existingIdx]?.identity : {}), name: answers.name },
  };
  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.push(entry);
  }
  const bindPlan = resolveInitBind(answers.bind);
  const next: KoLoConfig = {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        workspace,
      },
      list,
    },
    gateway: {
      ...base.gateway,
      mode: "local",
      bind: bindPlan.bind,
      auth: { ...base.gateway?.auth, mode: "token" },
      ...(bindPlan.remote ? { remote: { ...base.gateway?.remote, enabled: true } } : {}),
    },
  } as KoLoConfig;
  // Secure defaults (credential isolation, sandbox, exec approvals, memory quarantine) for a fresh
  // config only; an existing config keeps its behaviour and is told which settings still use
  // legacy defaults.
  const fresh = !existing || Boolean(opts.force);
  const secured = fresh
    ? applySecureDefaults(next, { identityAgentId: answers.name })
    : { config: next, applied: [] as string[] };
  const providerNote = await applyInitProvider(secured.config, answers, home);
  await writeConfigFile(providerNote.config);
  const legacyDefaults = findLegacyDefaults(providerNote.config);
  // Budgets and job limits: the signed starter policy, installed only when no policy exists.
  let policy: Awaited<ReturnType<typeof installStarterPolicyIfAbsent>> | null = null;
  if (fresh) {
    try {
      policy = await installStarterPolicyIfAbsent();
    } catch (err) {
      runtime.error(
        `policy: starter policy not installed (${String(err)}); run kurahi policy init`,
      );
    }
  } else {
    const policyPath = resolvePolicyLocations().policyPath;
    policy = fs.existsSync(policyPath) ? { installed: false, path: policyPath } : null;
  }
  const sandboxOn = (providerNote.config.agents?.defaults?.sandbox?.mode ?? "off") !== "off";
  const containerRuntime = sandboxOn ? await isDockerAvailable() : null;

  koloSecretsDir(home);
  const tokenPath = defaultGatewayTokenFilePath();
  const token = ensureGatewayTokenFile(tokenPath);
  const ws = await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
  const port = resolveGatewayPort(next);
  const report = await buildDoctorJsonReport();

  const phoneStep = (json: boolean) =>
    runInitPhoneStep({
      choice: opts.phone,
      interactive: !json && Boolean(interactive),
      json,
      gatewayBind: bindPlan.bind,
      runtime,
      deps: phoneDeps,
    });
  if (opts.json) {
    const phone = await phoneStep(true);
    runtime.log(
      JSON.stringify(
        {
          ok: report.ok,
          koloHome: home,
          configPath,
          tokenFile: tokenPath,
          tokenCreated: token.created,
          workspace: ws.dir,
          identity: answers.name,
          bind: answers.bind,
          gatewayBind: bindPlan.bind,
          remoteEnabled: bindPlan.remote,
          port,
          provider: providerNote.summary,
          secureDefaults: { applied: secured.applied, legacy: legacyDefaults.map((d) => d.key) },
          policy: policy
            ? { path: policy.path, installed: policy.installed, keyId: policy.keyId }
            : null,
          containerRuntime,
          doctor: report,
          ...(phone ? { phone } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Full-width labels do not pad evenly; align only when the labels are ASCII.
  const row = (key: string, value: string) => {
    const label = t(key);
    return /^[\x20-\x7e]+$/.test(label) ? `${label.padEnd(11)}${value}` : `${label}  ${value}`;
  };
  const lines = [
    row("init.k.state", home),
    row("init.k.config", configPath),
    row(
      "init.k.token",
      `${tokenPath} (${token.created ? t("init.token.created") : t("init.token.kept")}, 0600)`,
    ),
    row("init.k.workspace", ws.dir),
    row("init.k.identity", answers.name),
    row(
      "init.k.bind",
      `${bindPlan.bind}${bindPlan.remote ? ` (${t("init.bind.remoteNote")})` : ""}`,
    ),
    row("init.k.port", String(port)),
    row("init.k.provider", providerNote.summary),
    row(
      "init.k.security",
      legacyDefaults.length === 0
        ? t("init.security.secure")
        : t("init.security.legacy", { n: legacyDefaults.length }),
    ),
    row(
      "init.k.policy",
      policy?.installed
        ? t("init.policy.installed", { path: policy.path })
        : policy
          ? t("init.policy.kept", { path: policy.path })
          : t("init.policy.none"),
    ),
    ...(containerRuntime === false ? [row("init.k.security", t("init.sandbox.noRuntime"))] : []),
    row(
      "init.k.doctor",
      `${report.ok ? t("init.doctor.ok") : t("init.doctor.issues")} (${t("init.doctor.notes", { n: report.checks.filter((c) => c.level !== "ok").length })})`,
    ),
  ];
  if (opts.stateDir) {
    lines.push("", t("init.exportHint", { home }), `  export KOLO_HOME="${home}"`);
  }
  const nextSteps: Array<[string, string]> = [
    [`kurahi service install --id ${answers.name}`, t("init.next.service")],
    ["kurahi health", t("init.next.health")],
    answers.provider
      ? ["kurahi models list", t("init.next.models")]
      : ["kurahi onboard", t("init.next.onboard")],
    ["kurahi pair invite --scope attach", t("init.next.pair")],
    ["kurahi tui", t("init.next.tui")],
  ];
  const width = Math.max(...nextSteps.map(([cmd]) => cmd.length)) + 2;
  lines.push(
    "",
    t("init.next"),
    ...nextSteps.map(([cmd, what]) => `  ${cmd.padEnd(width)}${what}`),
  );
  lines.push("", `${t("init.docs")}: ${DOCS_URL}/start/getting-started`);
  if (interactive) {
    outro(t("init.ready"));
  }
  for (const line of lines) {
    runtime.log(line);
  }
  await phoneStep(false);
}
