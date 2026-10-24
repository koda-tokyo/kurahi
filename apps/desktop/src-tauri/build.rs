// Declaring the app commands here makes Tauri require an explicit permission for each one
// (capabilities/main.json); a command missing from the capability cannot be invoked.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "set_gateway_url",
            "service_control",
            "import_local_token",
            "set_language",
            "secret_get_all",
            "secret_set",
            "secret_delete",
            "audit_fetch",
        ]),
    ))
    .expect("failed to run tauri-build");
}
