// Typed wrappers for the Rust commands in src-tauri/src/lib.rs. Each one is also listed in
// build.rs and capabilities/main.json; nothing else is reachable from the webview.
import { invoke } from "@tauri-apps/api/core";

export type GatewayCondition = "running" | "attention" | "unhealthy" | "stopped";

export type HealthSnapshot = {
  condition: GatewayCondition;
  tray: "green" | "amber" | "red";
  status: string | null;
  version: string | null;
  http_status: number | null;
};

export type DesktopStatus = {
  appVersion: string;
  gatewayUrl: string;
  healthUrl: string;
  health: HealthSnapshot;
  cliFound: boolean;
  localTokenFound: boolean;
  keychainPersistent: boolean;
};

export type SecretSnapshot = { persistent: boolean; values: Record<string, string> };

export type CliResult = {
  ok: boolean;
  exit_code: number | null;
  json: unknown;
  message: string;
};

export type DesktopApi = {
  status(): Promise<DesktopStatus>;
  setGatewayUrl(url: string): Promise<string>;
  service(action: "start" | "stop" | "status"): Promise<CliResult>;
  importLocalToken(): Promise<boolean>;
  setLanguage(lang: string): Promise<void>;
  secretGetAll(): Promise<SecretSnapshot>;
  secretSet(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
  /** `/api/admin/audit` through Rust (fixed path, whitelisted params, token from the store). */
  auditFetch(params: object): Promise<unknown>;
};

export const desktopApi: DesktopApi = {
  status: () => invoke("desktop_status"),
  setGatewayUrl: (url) => invoke("set_gateway_url", { url }),
  service: (action) => invoke("service_control", { action }),
  importLocalToken: () => invoke("import_local_token"),
  // The tray has Japanese and English text; other UI locales fall back to English there.
  setLanguage: (lang) => invoke("set_language", { lang: lang === "ja" ? "ja" : "en" }),
  secretGetAll: () => invoke("secret_get_all"),
  secretSet: (key, value) => invoke("secret_set", { key, value }),
  secretDelete: (key) => invoke("secret_delete", { key }),
  auditFetch: (params) => invoke("audit_fetch", { params }),
};
