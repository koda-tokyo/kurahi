// A tiny message table for the first-run path: `kurahi init`, `kurahi doctor`, `kurahi health`, the
// top-level `--help` and error texts. English is the source; Japanese is the first translation.
// Language: `--lang ja` on the command line, else KOLO_LANG, else the OS locale (LANG,
// LC_ALL, LC_MESSAGES, or Intl). Keys are stable identifiers; call sites never carry prose
// in more than one language.

export type Lang = "en" | "ja";

export const SUPPORTED_LANGS: readonly Lang[] = ["en", "ja"];

type Table = Record<string, { en: string; ja: string }>;

const MESSAGES: Table = {
  tagline: { en: "resident agent runtime", ja: "常駐エージェント ランタイム" },
  "help.examples": { en: "Examples:", ja: "例:" },
  "help.docs": { en: "Docs:", ja: "ドキュメント:" },
  "help.ex.init": {
    en: "First run: state directory, config, gateway token, doctor report.",
    ja: "初回セットアップ: 状態ディレクトリ、設定、ゲートウェイトークン、診断。",
  },
  "help.ex.service": {
    en: "Run the gateway under systemd, launchd or Task Scheduler.",
    ja: "ゲートウェイを systemd / launchd / タスク スケジューラで常駐させる。",
  },
  "help.ex.health": {
    en: "One status line from the running gateway.",
    ja: "稼働中ゲートウェイの状態を 1 行で表示。",
  },
  "help.ex.pair": {
    en: "Invitation for a second device or terminal.",
    ja: "別の端末やターミナルを接続する招待コード。",
  },
  "help.ex.attach": { en: "Live sessions you may attach to.", ja: "接続できるセッションの一覧。" },
  "help.ex.tui": {
    en: "Talk to the agent in this terminal.",
    ja: "このターミナルでエージェントと対話。",
  },
  "help.ex.message": {
    en: "Send a message through a configured channel.",
    ja: "設定済みチャネル経由でメッセージを送信。",
  },
  "help.ex.api": {
    en: "Call any gateway API operation from the terminal.",
    ja: "ゲートウェイ API の任意の操作をターミナルから呼び出す。",
  },
  "error.unknownCommand": {
    en: "kolo: unknown command '{cmd}'",
    ja: "kolo: 不明なコマンド '{cmd}'",
  },
  "error.usage": {
    en: "Usage: kolo [options] [command]",
    ja: "使い方: kolo [オプション] [コマンド]",
  },
  "error.seeHelp": {
    en: "Run 'kurahi --help' for the list of commands.",
    ja: "コマンド一覧は 'kurahi --help' で表示できます。",
  },
  "health.ok": { en: "gateway ok", ja: "ゲートウェイ 正常" },
  "health.agents": { en: "{n} agent(s)", ja: "エージェント {n}" },
  "health.channels": {
    en: "{linked}/{total} channels linked",
    ja: "チャネル {linked}/{total} 接続中",
  },
  "health.noChannels": { en: "no channels", ja: "チャネルなし" },
  "health.sessions": { en: "{n} session(s)", ja: "セッション {n}" },
  "health.notRunning": {
    en: "kurahi health: gateway not running (start it with: kurahi service install, or kurahi gateway)",
    ja: "kurahi health: ゲートウェイが起動していません (起動: kurahi service install、または kurahi gateway)",
  },
  "health.failed": { en: "kurahi health: {reason}", ja: "kurahi health: {reason}" },
  "init.cancelled": { en: "init cancelled", ja: "init を中止しました" },
  "init.q.name": {
    en: "Identity name (used for the service id and the agent)",
    ja: "識別名 (サービス ID とエージェント名に使います)",
  },
  "init.q.bind": { en: "Who may reach the gateway?", ja: "ゲートウェイに接続できる範囲は?" },
  "init.q.bind.loopback": {
    en: "This machine only (loopback)",
    ja: "このマシンのみ (ループバック)",
  },
  "init.q.bind.remote": {
    en: "Other machines (requires a token on every connection)",
    ja: "他のマシンからも (すべての接続にトークンが必要)",
  },
  "init.q.provider": { en: "Model provider profile", ja: "モデルプロバイダーのプロファイル" },
  "init.q.provider.later": { en: "Decide later", ja: "後で決める" },
  "init.q.sakura.token": {
    en: "Sakura AI Engine API token (sign up: https://ai.sakura.ad.jp/sakura-ai/ai-engine/)",
    ja: "さくらのAI Engine の API トークン (登録: https://ai.sakura.ad.jp/sakura-ai/ai-engine/)",
  },
  "init.q.confirm": {
    en: "Write the config and generate the gateway token?",
    ja: "設定を書き込み、ゲートウェイトークンを生成しますか?",
  },
  "init.recommended": { en: "recommended", ja: "推奨" },
  "init.exists": {
    en: "config exists: {path} (merging; use --force to rewrite)",
    ja: "設定が既にあります: {path} (マージします。上書きは --force)",
  },
  "init.k.state": { en: "state", ja: "状態" },
  "init.k.config": { en: "config", ja: "設定" },
  "init.k.token": { en: "token", ja: "トークン" },
  "init.k.workspace": { en: "workspace", ja: "作業領域" },
  "init.k.identity": { en: "identity", ja: "識別名" },
  "init.k.bind": { en: "bind", ja: "接続範囲" },
  "init.k.port": { en: "port", ja: "ポート" },
  "init.k.provider": { en: "provider", ja: "プロバイダー" },
  "init.k.doctor": { en: "doctor", ja: "診断" },
  "init.k.security": { en: "security", ja: "セキュリティ" },
  "init.k.policy": { en: "policy", ja: "ポリシー" },
  "init.security.secure": {
    en: "secure defaults: credential isolation, sandbox for non-main sessions, exec approvals, pinned skills and plugins, memory quarantine",
    ja: "安全な既定値: 認証情報の分離、メイン以外のセッションはサンドボックス、コマンド実行は承認制、スキルとプラグインは固定済みのみ、メモリ書き込みの隔離",
  },
  "init.security.legacy": {
    en: "existing config kept; {n} setting(s) still use legacy defaults (see kurahi doctor)",
    ja: "既存の設定を維持。{n} 件の設定が従来の既定値のままです (kurahi doctor を参照)",
  },
  "init.policy.installed": {
    en: "starter policy installed and signed (budgets and job limits): {path}",
    ja: "スターターポリシーを導入・署名しました (予算とジョブ上限): {path}",
  },
  "init.policy.kept": { en: "existing policy kept: {path}", ja: "既存のポリシーを維持: {path}" },
  "init.policy.none": {
    en: "no policy: no budgets or job limits (run kurahi policy init)",
    ja: "ポリシーなし: 予算・ジョブ上限なし (kurahi policy init を実行)",
  },
  "init.sandbox.noRuntime": {
    en: "no container runtime found: exec is refused in sandboxed sessions until Docker and the sandbox image are installed",
    ja: "コンテナランタイムが見つかりません: Docker とサンドボックスイメージを導入するまで、サンドボックスのセッションではコマンド実行を拒否します",
  },
  "init.token.created": { en: "created", ja: "生成" },
  "init.token.kept": { en: "kept", ja: "既存" },
  "init.bind.remoteNote": {
    en: "token required on every connection",
    ja: "すべての接続にトークンが必要",
  },
  "init.doctor.ok": { en: "ok", ja: "正常" },
  "init.doctor.issues": { en: "issues", ja: "要確認" },
  "init.doctor.notes": {
    en: "{n} notes; kurahi doctor --json for detail",
    ja: "注記 {n} 件。詳細は kurahi doctor --json",
  },
  "init.exportHint": {
    en: "this run used KOLO_HOME={home}; export it so later commands find the same state:",
    ja: "今回は KOLO_HOME={home} を使いました。以降のコマンドでも同じ状態を使うには:",
  },
  "init.next": { en: "next:", ja: "次の手順:" },
  "init.next.service": {
    en: "run the gateway under the OS service manager",
    ja: "OS のサービス管理でゲートウェイを常駐させる",
  },
  "init.next.health": {
    en: "one status line from the gateway",
    ja: "ゲートウェイの状態を 1 行で確認",
  },
  "init.next.models": {
    en: "confirm the provider and model are visible",
    ja: "プロバイダーとモデルが表示されることを確認",
  },
  "init.next.onboard": { en: "choose a model provider", ja: "モデルプロバイダーを選ぶ" },
  "init.next.pair": {
    en: "invitation for a second device or terminal",
    ja: "別の端末やターミナルを接続する招待コード",
  },
  "init.next.tui": { en: "talk to the agent", ja: "エージェントと対話する" },
  "init.docs": { en: "docs", ja: "ドキュメント" },
  "init.ready": { en: "ready", ja: "準備完了" },
  "doctor.intro": { en: "kurahi doctor", ja: "kurahi doctor (診断)" },
  "support.wrote": {
    en: "diagnostics bundle written to {path}",
    ja: "診断バンドルを書き出しました: {path}",
  },
  "support.attach": {
    en: "attach it to the support ticket; it contains no secrets (values redacted).",
    ja: "サポートチケットに添付してください。シークレットは含まれません (値はマスク済み)。",
  },
};

let cached: Lang | null = null;

function fromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg?.startsWith("--lang=")) {
      return arg.slice("--lang=".length);
    }
  }
  return undefined;
}

function normalize(raw: string | undefined): Lang | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "c" || v === "posix") {
    return undefined;
  }
  if (v.startsWith("ja")) {
    return "ja";
  }
  if (v.startsWith("en")) {
    return "en";
  }
  return undefined;
}

export function resolveLang(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Lang {
  const explicit = normalize(fromArgv(argv)) ?? normalize(env.KOLO_LANG);
  if (explicit) {
    return explicit;
  }
  const osLocale =
    normalize(env.LC_ALL) ?? normalize(env.LC_MESSAGES) ?? normalize(env.LANG) ?? undefined;
  if (osLocale) {
    return osLocale;
  }
  try {
    return normalize(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
  } catch {
    return "en";
  }
}

export function currentLang(): Lang {
  cached ??= resolveLang();
  return cached;
}

/** Override for tests and for `--lang` handling before argv is parsed. */
export function setLang(lang: Lang | null): void {
  cached = lang;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = MESSAGES[key];
  const text = entry ? entry[currentLang()] || entry.en : key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

export function hasMessage(key: string): boolean {
  return key in MESSAGES;
}
