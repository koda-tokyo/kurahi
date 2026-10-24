//! Kurahi Desktop: a thin shell around the bundled Control UI.
//!
//! - The webview loads only bundled assets (`frontendDist`); no remote URL.
//! - The gateway is reached on loopback only (gateway_url.rs).
//! - The tray shows `/health` (health.rs) and starts/stops the service through the `kurahi`
//!   CLI with fixed arguments (cli.rs). There is no shell and no generic process API.
//! - Secrets live in the OS keychain (secrets.rs).

mod audit;
mod cli;
mod config;
mod gateway_url;
mod health;
mod i18n;
mod secrets;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, WindowEvent, Wry};

use cli::{CliResult, ServiceAction};
use gateway_url::{parse_gateway_url, GatewayUrl};
use health::{HealthSnapshot, TrayState};
use i18n::Lang;
use secrets::{SecretSnapshot, SecretStore};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const TRAY_ID: &str = "kurahi";

struct TrayItems {
    status: MenuItem<Wry>,
    open: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

struct AppState {
    gateway: Mutex<GatewayUrl>,
    health: Mutex<HealthSnapshot>,
    lang: Mutex<Lang>,
    busy: AtomicBool,
    secrets: OnceLock<SecretStore>,
    config_path: Option<PathBuf>,
    tray: OnceLock<TrayItems>,
}

impl AppState {
    fn secrets(&self) -> &SecretStore {
        self.secrets.get_or_init(SecretStore::open)
    }
    fn gateway(&self) -> GatewayUrl {
        self.gateway.lock().map(|g| g.clone()).unwrap_or_default()
    }
    fn lang(&self) -> Lang {
        self.lang.lock().map(|l| *l).unwrap_or(Lang::En)
    }
}

fn tray_png(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Green => include_bytes!("../icons/tray-green.png"),
        TrayState::Amber => include_bytes!("../icons/tray-amber.png"),
        TrayState::Red => include_bytes!("../icons/tray-red.png"),
    }
}

fn status_line(lang: Lang, h: &HealthSnapshot) -> String {
    let text = i18n::condition_text(lang, h.condition);
    match &h.version {
        Some(v) => format!("Kurahi: {text} ({v})"),
        None => format!("Kurahi: {text}"),
    }
}

/// Push the current health and language to the tray icon and menu.
fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let h = state
        .health
        .lock()
        .map(|h| h.clone())
        .unwrap_or_else(|_| HealthSnapshot::stopped());
    let busy = state.busy.load(Ordering::SeqCst);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(img) = Image::from_bytes(tray_png(h.tray)) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(status_line(lang, &h)));
    }
    if let Some(items) = state.tray.get() {
        let t = i18n::tray_text(lang);
        let status = if busy {
            format!("Kurahi: {}", i18n::busy_text(lang))
        } else {
            status_line(lang, &h)
        };
        let _ = items.status.set_text(status);
        let _ = items.open.set_text(t.open);
        let _ = items.start.set_text(t.start);
        let _ = items.stop.set_text(t.stop);
        let _ = items.quit.set_text(t.quit);
        let running = !matches!(h.condition, health::GatewayCondition::Stopped);
        let _ = items.start.set_enabled(!busy && !running);
        let _ = items.stop.set_enabled(!busy && running);
    }
}

fn probe_now(app: &AppHandle) -> HealthSnapshot {
    let state = app.state::<AppState>();
    let snap = health::probe(&state.gateway());
    let changed = match state.health.lock() {
        Ok(mut h) => {
            let changed = *h != snap;
            *h = snap.clone();
            changed
        }
        Err(_) => true,
    };
    // Touch the tray only when something changed (some desktops, e.g. WSLg without a tray
    // host, log a warning on every icon update).
    if changed {
        refresh_tray(app);
    }
    snap
}

fn start_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        probe_now(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

/// Run one service action; refuses to run two at once.
fn run_service_action(app: &AppHandle, action: ServiceAction) -> Result<CliResult, String> {
    let state = app.state::<AppState>();
    let cli = cli::locate_cli().ok_or_else(|| "Kurahi CLI not found".to_string())?;
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("another service action is running".into());
    }
    refresh_tray(app);
    let result = cli::run_service(&cli, action);
    state.busy.store(false, Ordering::SeqCst);
    // Give the service a moment to bind or release the port before re-probing.
    std::thread::sleep(Duration::from_millis(1200));
    probe_now(app);
    Ok(result)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let t = i18n::tray_text(lang);
    let status = MenuItem::with_id(
        app,
        "status",
        status_line(lang, &HealthSnapshot::stopped()),
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", t.open, true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", t.start, true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", t.stop, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let _ = state.tray.set(TrayItems {
        status,
        open,
        start,
        stop,
        quit,
    });
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(tray_png(TrayState::Red))?)
        .tooltip("Kurahi")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "start" | "stop" => {
                let action = if event.id.as_ref() == "start" {
                    ServiceAction::Start
                } else {
                    ServiceAction::Stop
                };
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = run_service_action(&app, action);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
}

// ---- commands (each one listed in build.rs and capabilities/main.json) ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    app_version: &'static str,
    gateway_url: String,
    health_url: String,
    health: HealthSnapshot,
    cli_found: bool,
    local_token_found: bool,
    keychain_persistent: bool,
}

fn local_token_path() -> Option<PathBuf> {
    let env = |k: &str| std::env::var(k).ok();
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    secrets::local_token_path(&env, home)
}

#[tauri::command]
async fn desktop_status(app: AppHandle) -> Result<DesktopStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let health = probe_now(&app);
        let state = app.state::<AppState>();
        DesktopStatus {
            app_version: env!("CARGO_PKG_VERSION"),
            gateway_url: state.gateway().ws_url(),
            health_url: format!("{}/health", state.gateway().http_base()),
            health,
            cli_found: cli::locate_cli().is_some(),
            local_token_found: local_token_path().map(|p| p.is_file()).unwrap_or(false),
            keychain_persistent: state.secrets().persistent,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_gateway_url(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = parse_gateway_url(&url)?;
    let state = app.state::<AppState>();
    if let Some(path) = &state.config_path {
        config::save_gateway(path, &parsed)?;
    }
    if let Ok(mut g) = state.gateway.lock() {
        *g = parsed.clone();
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        probe_now(&app2);
    });
    Ok(parsed.ws_url())
}

#[tauri::command]
async fn service_control(app: AppHandle, action: ServiceAction) -> Result<CliResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_service_action(&app, action))
        .await
        .map_err(|e| e.to_string())?
}

/// Copy this computer's gateway token (`<KOLO_HOME>/secrets/gateway.token`) into the keychain.
/// The token is not returned; the Control UI reads it from the keychain when it loads.
#[tauri::command]
async fn import_local_token(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = local_token_path().ok_or_else(|| "no home directory".to_string())?;
        let raw = std::fs::read(&path).map_err(|_| "token file not found".to_string())?;
        if raw.len() > 4096 {
            return Err("token file is too large".to_string());
        }
        let token = secrets::validate_token(&String::from_utf8_lossy(&raw))?;
        app.state::<AppState>()
            .secrets()
            .set(secrets::ALLOWED_KEYS[0], &token)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_language(app: AppHandle, lang: Lang) {
    if let Ok(mut l) = app.state::<AppState>().lang.lock() {
        *l = lang;
    }
    refresh_tray(&app);
}

/// Read one page of `/api/admin/audit` from the loopback gateway (see audit.rs). The URL comes
/// from the validated desktop config, the token from the secret store; only the whitelisted
/// query parameters come from the webview.
#[tauri::command]
async fn audit_fetch(
    app: AppHandle,
    params: audit::AuditParams,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let token = state
            .secrets()
            .get(secrets::ALLOWED_KEYS[0])?
            .map(|t| secrets::validate_token(&t))
            .transpose()?;
        audit::fetch(&state.gateway(), token.as_deref(), &params)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secret_get_all(app: AppHandle) -> Result<SecretSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().secrets().get_all())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().secrets().set(&key, &value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().secrets().delete(&key))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| d.join("desktop.json"));
            let gateway = config_path
                .as_deref()
                .map(config::load_gateway)
                .unwrap_or_default();
            let lang = i18n::lang_from_locale(sys_locale::get_locale().as_deref());
            app.manage(AppState {
                gateway: Mutex::new(gateway),
                health: Mutex::new(HealthSnapshot::stopped()),
                lang: Mutex::new(lang),
                busy: AtomicBool::new(false),
                secrets: OnceLock::new(),
                config_path,
                tray: OnceLock::new(),
            });
            let handle = app.handle().clone();
            setup_tray(&handle)?;
            // Open the keychain off the main thread (a Secret Service lookup can be slow).
            let h2 = handle.clone();
            std::thread::spawn(move || {
                let _ = h2.state::<AppState>().secrets();
            });
            start_poller(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Kurahi in the tray; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            set_gateway_url,
            service_control,
            import_local_token,
            set_language,
            secret_get_all,
            secret_set,
            secret_delete,
            audit_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kurahi Desktop");
}
