import type { ThemeMode } from "./theme";
import { hasExternalSecretStorage, SECRET_STORAGE_KEYS, secretStorage } from "./secret-storage";
import {
  isEditionId,
  resolveWorkspaceId,
  type EditionId,
  type WorkspaceId,
} from "./editions/manifests";

const KEY = "KoLo.control.settings.v1";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  /** The user's language choice (BCP 47); null follows the organisation default, then the OS. */
  locale: string | null;
  /** Licensed product surface. This changes presentation, never shared security policy. */
  edition?: EditionId;
  /** Active layout within the licensed edition. */
  workspace?: WorkspaceId;
};

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    // Industrial opens as a control-room surface; users can still choose light or system.
    theme: "dark",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    locale: null,
    edition: "industrial",
    workspace: "industrial",
  };

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return hasExternalSecretStorage() ? { ...defaults, token: readExternalToken() } : defaults;
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    if (hasExternalSecretStorage()) {
      // A host secret store owns the token. Move a token left in localStorage by an older build.
      if (typeof parsed.token === "string" && parsed.token) {
        if (!readExternalToken()) {
          secretStorage().setItem(SECRET_STORAGE_KEYS.gatewayToken, parsed.token);
        }
        const { token: _dropped, ...rest } = parsed;
        localStorage.setItem(KEY, JSON.stringify(rest));
      }
      parsed.token = readExternalToken();
    }
    const edition = isEditionId(parsed.edition) ? parsed.edition : defaults.edition!;
    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      locale:
        typeof parsed.locale === "string" &&
        /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(parsed.locale)
          ? parsed.locale
          : defaults.locale,
      edition,
      workspace: resolveWorkspaceId(
        edition,
        typeof parsed.workspace === "string" ? parsed.workspace : defaults.workspace,
      ),
    };
  } catch {
    return defaults;
  }
}

function readExternalToken(): string {
  try {
    return secretStorage().getItem(SECRET_STORAGE_KEYS.gatewayToken) ?? "";
  } catch {
    return "";
  }
}

export function saveSettings(next: UiSettings) {
  if (hasExternalSecretStorage()) {
    // The token goes to the host secret store, never into the localStorage JSON.
    const { token, ...rest } = next;
    if (token) {
      secretStorage().setItem(SECRET_STORAGE_KEYS.gatewayToken, token);
    } else {
      secretStorage().removeItem(SECRET_STORAGE_KEYS.gatewayToken);
    }
    localStorage.setItem(KEY, JSON.stringify(rest));
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(next));
}
