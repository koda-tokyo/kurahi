// First-run screen text: a catalogue keyed by message ID, one entry per locale.
// Only ja and en ship in v0.1; more locales are added after native review, never machine
// translated. A missing message falls back to English, then to the ID itself.

export const LOCALES = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
] as const;

export type LocaleId = (typeof LOCALES)[number]["id"];

const en = {
  "app.tagline": "Desktop control for the Kurahi agent runtime",
  "app.by": "by KODA SōKEN",
  "step.engine": "Kurahi engine on this computer",
  "step.service": "Kurahi service",
  "step.connect": "Connection",
  "engine.found": "Installed",
  "engine.missing":
    "The Kurahi engine was not found on this computer. Ask your IT administrator to install Kurahi, then press Check again.",
  "service.running": "Running",
  "service.attention": "Running, but needs attention. You can still open Kurahi and check the details.",
  "service.unhealthy": "Not healthy. Try Stop service, then Start service. If it persists, contact your administrator.",
  "service.stopped": "Stopped. Press Start service.",
  "service.stoppedNoCli": "Not reachable. Start the Kurahi service on this computer, or check the address under Advanced.",
  "service.start": "Start service",
  "service.stop": "Stop service",
  "service.working": "Working…",
  "service.failed": "The service command did not succeed:",
  "connect.stored": "A connection token is stored in this computer's secure credential store.",
  "connect.localFound": "This computer's Kurahi connection token was found.",
  "connect.useLocal": "Use this computer's token",
  "connect.none": "No connection token yet. Use this computer's token, or paste the token your administrator gave you.",
  "connect.paste": "Paste a token",
  "connect.save": "Save token",
  "connect.saved": "Token saved.",
  "connect.autoLocal":
    "Connected with this computer's token (this system has no keychain, so it is read again at each start).",
  "connect.clear": "Remove stored token",
  "connect.device":
    "On first connection this app registers as a device of the local Kurahi service. Its device key is kept in the secure credential store.",
  "connect.notPersistent":
    "This computer's secure credential store is not available. The token is kept only until you quit the app.",
  "advanced.title": "Advanced",
  "advanced.url": "Gateway address (this computer only)",
  "advanced.save": "Save address",
  "advanced.saved": "Address saved.",
  "action.open": "Open Kurahi",
  "action.check": "Check again",
  "lang.label": "Language",
  "footer.version": "Version",
  "footer.unsigned": "Unsigned test build",
} as const;

export type MessageId = keyof typeof en;

const ja: Partial<Record<MessageId, string>> = {
  "app.tagline": "Kurahi エージェント実行基盤のデスクトップ操作画面",
  "app.by": "KODA SōKEN",
  "step.engine": "このコンピューターの Kurahi エンジン",
  "step.service": "Kurahi サービス",
  "step.connect": "接続",
  "engine.found": "インストール済み",
  "engine.missing":
    "このコンピューターに Kurahi エンジンが見つかりません。IT 管理者にインストールを依頼してから「再確認」を押してください。",
  "service.running": "稼働中",
  "service.attention": "稼働していますが、確認が必要です。Kurahi を開いて詳細を確認できます。",
  "service.unhealthy": "正常ではありません。「サービスを停止」の後「サービスを開始」を押してください。改善しない場合は管理者に連絡してください。",
  "service.stopped": "停止しています。「サービスを開始」を押してください。",
  "service.stoppedNoCli": "接続できません。このコンピューターで Kurahi サービスを起動するか、「詳細設定」のアドレスを確認してください。",
  "service.start": "サービスを開始",
  "service.stop": "サービスを停止",
  "service.working": "処理中…",
  "service.failed": "サービスの操作に失敗しました:",
  "connect.stored": "接続トークンはこのコンピューターの安全な資格情報ストアに保存されています。",
  "connect.localFound": "このコンピューターの Kurahi 接続トークンが見つかりました。",
  "connect.useLocal": "このコンピューターのトークンを使う",
  "connect.none": "接続トークンがまだありません。このコンピューターのトークンを使うか、管理者から受け取ったトークンを貼り付けてください。",
  "connect.paste": "トークンを貼り付け",
  "connect.save": "トークンを保存",
  "connect.saved": "トークンを保存しました。",
  "connect.autoLocal":
    "このコンピューターのトークンで接続しました（キーチェーンがないため、起動のたびに読み込みます）。",
  "connect.clear": "保存したトークンを削除",
  "connect.device":
    "初回接続時に、このアプリはローカルの Kurahi サービスに端末として登録されます。端末の鍵は安全な資格情報ストアに保存されます。",
  "connect.notPersistent":
    "このコンピューターの安全な資格情報ストアを利用できません。トークンはアプリを終了するまでの間だけ保持されます。",
  "advanced.title": "詳細設定",
  "advanced.url": "ゲートウェイのアドレス(このコンピューターのみ)",
  "advanced.save": "アドレスを保存",
  "advanced.saved": "アドレスを保存しました。",
  "action.open": "Kurahi を開く",
  "action.check": "再確認",
  "lang.label": "言語",
  "footer.version": "バージョン",
  "footer.unsigned": "署名なしテストビルド",
};

const CATALOGUE: Record<LocaleId, Partial<Record<MessageId, string>>> = { en, ja };

export function isLocale(id: string | null | undefined): id is LocaleId {
  return LOCALES.some((l) => l.id === id);
}

/** Best supported locale for a list of OS/browser preferences (BCP 47 tags). */
export function matchLocale(preferred: readonly string[], fallback: LocaleId = "en"): LocaleId {
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    const exact = LOCALES.find((l) => l.id.toLowerCase() === lower);
    if (exact) {
      return exact.id;
    }
    const base = lower.split(/[-_]/)[0];
    const byBase = LOCALES.find((l) => l.id.toLowerCase().split("-")[0] === base);
    if (byBase) {
      return byBase.id;
    }
  }
  return fallback;
}

/** A saved user choice wins; else the OS locale. */
export function resolveLocale(saved: string | null, preferred: readonly string[]): LocaleId {
  return isLocale(saved) ? saved : matchLocale(preferred);
}

export function t(locale: LocaleId, id: MessageId): string {
  return CATALOGUE[locale]?.[id] ?? en[id] ?? id;
}

/** Message IDs a locale has not translated (for review tooling and tests). */
export function missingMessages(locale: LocaleId): MessageId[] {
  return (Object.keys(en) as MessageId[]).filter((id) => CATALOGUE[locale]?.[id] == null);
}
