//! The `kurahi` CLI, called with fixed arguments only.
//!
//! The desktop app never runs a shell and never passes text from the webview to a process.
//! The webview can ask for one of the `ServiceAction` values; each maps to a fixed argv for
//! `kurahi service <start|stop|status> --json` (src/cli/service-cli.ts).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Env override for the CLI location (set by an installer or an administrator, never by the
/// webview). It must name an existing file.
pub const CLI_ENV: &str = "KURAHI_CLI";
const OUTPUT_CAP: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Stop,
    Status,
}

/// The exact argv (after the program) for an action.
pub fn service_args(action: ServiceAction) -> [&'static str; 3] {
    match action {
        ServiceAction::Start => ["service", "start", "--json"],
        ServiceAction::Stop => ["service", "stop", "--json"],
        ServiceAction::Status => ["service", "status", "--json"],
    }
}

fn candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["kurahi.exe", "kurahi.cmd"]
    } else {
        &["kurahi"]
    }
}

/// Find the CLI: `KURAHI_CLI` if it names a file, else the first match on `PATH`.
pub fn locate_cli_in(
    env_override: Option<OsString>,
    path_var: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(p) = env_override {
        let p = PathBuf::from(p);
        return if p.is_absolute() && p.is_file() {
            Some(p)
        } else {
            None
        };
    }
    let path_var = path_var?;
    for dir in std::env::split_paths(&path_var) {
        if !dir.is_absolute() {
            // A relative PATH entry would resolve against the app's working directory.
            continue;
        }
        for name in candidate_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn locate_cli() -> Option<PathBuf> {
    locate_cli_in(std::env::var_os(CLI_ENV), std::env::var_os("PATH"))
}

#[derive(Debug, Clone, Serialize)]
pub struct CliResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    /// Parsed `--json` output when the CLI printed one JSON object.
    pub json: Option<serde_json::Value>,
    /// Byte-capped stderr for the error message.
    pub message: String,
}

fn cap(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(&bytes[..bytes.len().min(OUTPUT_CAP)]).to_string();
    s.trim().to_string()
}

/// Pick the last line of stdout that parses as a JSON object (the CLI may log before it).
pub fn parse_cli_json(stdout: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if v.is_object() {
            return Some(v);
        }
    }
    stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .find(|v| v.is_object())
}

/// Run one fixed service action. Blocks up to 60 s; call from a worker thread.
pub fn run_service(cli: &Path, action: ServiceAction) -> CliResult {
    let mut cmd = Command::new(cli);
    cmd.args(service_args(action))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return CliResult {
                ok: false,
                exit_code: None,
                json: None,
                message: format!("could not start the Kurahi CLI: {e}"),
            }
        }
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return CliResult {
                    ok: false,
                    exit_code: None,
                    json: None,
                    message: "the Kurahi CLI timed out".into(),
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                return CliResult {
                    ok: false,
                    exit_code: None,
                    json: None,
                    message: e.to_string(),
                }
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            return CliResult {
                ok: false,
                exit_code: None,
                json: None,
                message: e.to_string(),
            }
        }
    };
    let stdout = cap(&output.stdout);
    let json = parse_cli_json(&stdout);
    let json_ok = json
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let ok = output.status.success() && json_ok;
    let mut message = cap(&output.stderr);
    if message.is_empty() {
        if let Some(err) = json
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|v| v.as_str())
        {
            message = err.chars().take(500).collect();
        }
    }
    CliResult {
        ok,
        exit_code: output.status.code(),
        json,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn argv_is_fixed() {
        assert_eq!(
            service_args(ServiceAction::Start),
            ["service", "start", "--json"]
        );
        assert_eq!(
            service_args(ServiceAction::Stop),
            ["service", "stop", "--json"]
        );
        assert_eq!(
            service_args(ServiceAction::Status),
            ["service", "status", "--json"]
        );
    }

    #[test]
    fn action_deserialises_only_known_values() {
        assert_eq!(
            serde_json::from_str::<ServiceAction>("\"start\"").unwrap(),
            ServiceAction::Start
        );
        assert!(serde_json::from_str::<ServiceAction>("\"rm -rf /\"").is_err());
        assert!(serde_json::from_str::<ServiceAction>("\"install\"").is_err());
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("kurahi-desktop-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn locates_on_path_and_skips_relative_entries() {
        let dir = tmpdir("path");
        let name = candidate_names()[0];
        fs::write(dir.join(name), "").unwrap();
        let path = std::env::join_paths([PathBuf::from("relative/dir"), dir.clone()]).unwrap();
        assert_eq!(locate_cli_in(None, Some(path)), Some(dir.join(name)));
        let empty = tmpdir("empty");
        assert_eq!(
            locate_cli_in(None, Some(std::env::join_paths([empty]).unwrap())),
            None
        );
        assert_eq!(locate_cli_in(None, None), None);
    }

    #[test]
    fn env_override_must_be_an_absolute_file() {
        let dir = tmpdir("env");
        let f = dir.join("kurahi-custom");
        fs::write(&f, "").unwrap();
        assert_eq!(locate_cli_in(Some(f.clone().into()), None), Some(f));
        assert_eq!(locate_cli_in(Some("kurahi".into()), None), None);
        assert_eq!(locate_cli_in(Some(dir.join("missing").into()), None), None);
    }

    #[test]
    fn parses_json_output() {
        assert_eq!(parse_cli_json("{\"ok\":true}").unwrap()["ok"], true);
        let noisy = "warning: something\n{\"ok\":false,\"error\":\"not installed\"}\n";
        assert_eq!(parse_cli_json(noisy).unwrap()["error"], "not installed");
        assert!(parse_cli_json("plain text").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_fake_cli_with_fixed_argv() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir("run");
        let script = dir.join("kurahi");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '{\"ok\":true,\"argv\":\"%s\"}\\n' \"$*\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let r = run_service(&script, ServiceAction::Stop);
        assert!(r.ok, "{r:?}");
        assert_eq!(r.json.unwrap()["argv"], "service stop --json");

        fs::write(
            &script,
            "#!/bin/sh\necho '{\"ok\":false,\"error\":\"no unit\"}'\nexit 1\n",
        )
        .unwrap();
        let r = run_service(&script, ServiceAction::Start);
        assert!(!r.ok);
        assert_eq!(r.message, "no unit");
    }
}
