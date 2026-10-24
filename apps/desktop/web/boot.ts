// First-run screen: is Kurahi installed and running, is there a connection token, then open the
// bundled Control UI pointed at the loopback gateway.
import { desktopApi, type DesktopStatus } from "./desktop-api";
import { LOCALES, resolveLocale, t, type LocaleId, type MessageId } from "./i18n";
import { createKeychainStorage, type KeychainStorage } from "./keychain-storage";
import { SECRET_STORAGE_KEYS } from "../../../ui/src/ui/secret-storage";

const LANG_KEY = "kurahi.desktop.locale";
const SETTINGS_KEY = "KoLo.control.settings.v1";
const POLL_MS = 3000;

const ICON = {
  ok: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 21 19.5H3z"/><path d="M12 10v4.5"/><path d="M12 17.2v.1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
} as const;

type View = {
  status: DesktopStatus | null;
  busy: boolean;
  notice: string;
  error: string;
};

function readLocale(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

let locale: LocaleId = resolveLocale(readLocale(), navigator.languages ?? [navigator.language]);
const view: View = { status: null, busy: false, notice: "", error: "" };
let storage: KeychainStorage | null = null;
let autoOpenAllowed = !new URLSearchParams(location.search).has("setup");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tr = (id: MessageId) => t(locale, id);

function hasToken(): boolean {
  return Boolean(storage?.backend.getItem(SECRET_STORAGE_KEYS.gatewayToken));
}

function setIcon(el: HTMLElement, kind: keyof typeof ICON) {
  el.innerHTML = ICON[kind]; // static SVG markup only
  el.dataset.kind = kind;
}

function renderStatic() {
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = tr(el.dataset.i18n as MessageId);
  }
  for (const el of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    el.placeholder = tr(el.dataset.i18nPlaceholder as MessageId);
  }
  const langs = $("langs");
  langs.replaceChildren();
  for (const l of LOCALES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = l.label;
    b.lang = l.id;
    b.setAttribute("aria-pressed", String(l.id === locale));
    b.addEventListener("click", () => setLocale(l.id));
    langs.append(b);
  }
}

function render() {
  const s = view.status;
  const engine = $("engine-state");
  const engineText = $("engine-text");
  const service = $("service-state");
  const serviceText = $("service-text");
  const connect = $("connect-state");
  const connectText = $("connect-text");

  if (!s) {
    return;
  }
  const running = s.health.condition === "running" || s.health.condition === "attention";

  if (s.cliFound) {
    setIcon(engine, "ok");
    engineText.textContent = tr("engine.found");
  } else if (running) {
    setIcon(engine, "warn");
    engineText.textContent = tr("engine.missing");
  } else {
    setIcon(engine, "stop");
    engineText.textContent = tr("engine.missing");
  }

  const cond = s.health.condition;
  setIcon(service, cond === "running" ? "ok" : cond === "attention" ? "warn" : "stop");
  const serviceMsg: Record<typeof cond, MessageId> = {
    running: "service.running",
    attention: "service.attention",
    unhealthy: "service.unhealthy",
    stopped: s.cliFound ? "service.stopped" : "service.stoppedNoCli",
  };
  serviceText.textContent =
    tr(serviceMsg[cond]) + (s.health.version && running ? ` (${s.health.version})` : "");

  const start = $<HTMLButtonElement>("btn-start");
  const stop = $<HTMLButtonElement>("btn-stop");
  start.hidden = !s.cliFound || running;
  stop.hidden = !s.cliFound || !running;
  start.disabled = stop.disabled = view.busy;
  if (view.busy) {
    (running ? stop : start).textContent = tr("service.working");
  }

  const token = hasToken();
  setIcon(connect, token ? "ok" : "warn");
  connectText.textContent = token
    ? tr("connect.stored")
    : s.localTokenFound
      ? tr("connect.localFound")
      : tr("connect.none");
  $("btn-local").hidden = token || !s.localTokenFound;
  $("btn-clear").hidden = !token;
  $("persist-warning").hidden = storage?.persistent !== false;

  const url = $<HTMLInputElement>("gateway-url");
  if (document.activeElement !== url) {
    url.value = s.gatewayUrl;
  }
  $("version").textContent = s.appVersion;
  $("notice").textContent = view.notice;
  $("error").textContent = view.error;
  $<HTMLButtonElement>("btn-open").disabled = !running;

  if (autoOpenAllowed && running && token) {
    autoOpenAllowed = false;
    void openControl();
  }
}

function setLocale(id: LocaleId) {
  locale = id;
  try {
    localStorage.setItem(LANG_KEY, id);
  } catch {
    // per-viewer convenience only
  }
  void desktopApi.setLanguage(id).catch(() => {});
  renderStatic();
  render();
}

async function refresh() {
  try {
    view.status = await desktopApi.status();
  } catch (err) {
    view.error = String(err);
  }
  render();
}

async function serviceAction(action: "start" | "stop") {
  view.busy = true;
  view.error = "";
  view.notice = "";
  render();
  try {
    const r = await desktopApi.service(action);
    if (!r.ok) {
      view.error = `${tr("service.failed")} ${r.message || `exit ${r.exit_code ?? "?"}`}`;
    }
  } catch (err) {
    view.error = `${tr("service.failed")} ${String(err)}`;
  }
  view.busy = false;
  // Re-render the button labels that showed "Working…".
  renderStatic();
  await refresh();
}

async function reloadSecrets() {
  storage = await createKeychainStorage(desktopApi, window.localStorage);
}

async function useLocalToken() {
  view.error = "";
  try {
    await desktopApi.importLocalToken();
    await reloadSecrets();
    view.notice = tr("connect.saved");
  } catch (err) {
    view.error = String(err);
  }
  render();
}

/**
 * Without an OS keychain (WSL, some Linux desktops) a token only lives until the app quits, so
 * "Use this computer's token" would be needed at every start. There, read the local gateway's
 * token automatically: the same file, same user, as the button. Never with a persistent keychain,
 * where the first import is the user's explicit choice.
 */
async function autoImportWithoutKeychain() {
  if (hasToken() || storage?.persistent !== false || !view.status?.localTokenFound) {
    return;
  }
  await useLocalToken();
  if (!view.error) {
    view.notice = tr("connect.autoLocal");
    render();
  }
}

async function savePastedToken(ev: Event) {
  ev.preventDefault();
  const input = $<HTMLInputElement>("token-input");
  const token = input.value.trim();
  if (!token || !storage) {
    return;
  }
  storage.backend.setItem(SECRET_STORAGE_KEYS.gatewayToken, token);
  input.value = "";
  try {
    await storage.flush();
    view.notice = tr("connect.saved");
    view.error = "";
  } catch (err) {
    view.error = String(err);
  }
  render();
}

async function clearToken() {
  storage?.backend.removeItem(SECRET_STORAGE_KEYS.gatewayToken);
  await storage?.flush();
  view.notice = "";
  render();
}

async function saveUrl(ev: Event) {
  ev.preventDefault();
  view.error = "";
  try {
    await desktopApi.setGatewayUrl($<HTMLInputElement>("gateway-url").value);
    view.notice = tr("advanced.saved");
  } catch (err) {
    view.error = String(err);
  }
  await refresh();
}

/** Point the Control UI at the configured loopback gateway and load it. */
async function openControl() {
  const s = view.status;
  if (!s) {
    return;
  }
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    settings = {};
  }
  delete settings.token; // the token lives in the keychain, never here
  settings.gatewayUrl = s.gatewayUrl;
  // A language picked on this screen carries over to the Control UI (its own Settings can change it).
  const picked = readLocale();
  if (picked) {
    settings.locale = picked;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  await storage?.flush();
  location.href = "control.html";
}

function wire() {
  $("btn-start").addEventListener("click", () => void serviceAction("start"));
  $("btn-stop").addEventListener("click", () => void serviceAction("stop"));
  $("btn-local").addEventListener("click", () => void useLocalToken());
  $("btn-clear").addEventListener("click", () => void clearToken());
  $("btn-check").addEventListener("click", () => {
    view.notice = "";
    view.error = "";
    void refresh();
  });
  $("btn-open").addEventListener("click", () => void openControl());
  $("token-form").addEventListener("submit", (ev) => void savePastedToken(ev));
  $("url-form").addEventListener("submit", (ev) => void saveUrl(ev));
}

async function main() {
  renderStatic();
  wire();
  void desktopApi.setLanguage(locale).catch(() => {});
  try {
    await reloadSecrets();
  } catch (err) {
    view.error = String(err);
  }
  await refresh();
  await autoImportWithoutKeychain();
  window.setInterval(() => {
    if (!view.busy) {
      void refresh();
    }
  }, POLL_MS);
}

void main();
