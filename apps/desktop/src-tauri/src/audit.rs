//! `audit_fetch`: read the gateway's `/api/admin/audit` from Rust.
//!
//! The desktop webview is a different origin from the gateway, and the gateway sends no CORS
//! headers (and should not). This command makes the request instead: loopback gateway URL only
//! (validated in gateway_url.rs), fixed path, whitelisted and validated query parameters, and
//! the gateway token from the app's secret store. The webview never supplies a URL or a header.

use serde::Deserialize;
use url::form_urlencoded;

use crate::gateway_url::GatewayUrl;
use crate::health::http_get;

pub const AUDIT_PATH: &str = "/api/admin/audit";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// The only query parameters accepted (the gateway's `AuditQuery`, src/gateway/http-routes.ts).
#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditParams {
    pub user_id: Option<String>,
    pub action: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

fn check(name: &str, value: &str, max: usize, allowed: fn(char) -> bool) -> Result<(), String> {
    if value.is_empty() || value.len() > max || !value.chars().all(allowed) {
        return Err(format!("invalid {name}"));
    }
    Ok(())
}

fn ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '@' | '/')
}

fn date_char(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '.' | '+')
}

fn cursor_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '=' | '.' | ':')
}

/// Validate the parameters and build `/api/admin/audit?…`.
pub fn build_path(params: &AuditParams) -> Result<String, String> {
    let mut q = form_urlencoded::Serializer::new(String::new());
    let idents = [
        ("userId", &params.user_id),
        ("action", &params.action),
        ("targetType", &params.target_type),
        ("targetId", &params.target_id),
    ];
    for (name, value) in idents {
        if let Some(v) = value {
            check(name, v, 128, ident_char)?;
            q.append_pair(name, v);
        }
    }
    for (name, value) in [
        ("startDate", &params.start_date),
        ("endDate", &params.end_date),
    ] {
        if let Some(v) = value {
            check(name, v, 40, date_char)?;
            q.append_pair(name, v);
        }
    }
    let limit = params.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err("invalid limit".into());
    }
    q.append_pair("limit", &limit.to_string());
    if let Some(v) = &params.cursor {
        check("cursor", v, 512, cursor_char)?;
        q.append_pair("cursor", v);
    }
    Ok(format!("{AUDIT_PATH}?{}", q.finish()))
}

/// Fetch one audit page. Returns the gateway's JSON body; a non-2xx answer is an error.
pub fn fetch(
    url: &GatewayUrl,
    token: Option<&str>,
    params: &AuditParams,
) -> Result<serde_json::Value, String> {
    let path = build_path(params)?;
    let auth = token.map(|t| format!("Bearer {t}"));
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if let Some(a) = auth.as_deref() {
        headers.push(("Authorization", a));
    }
    let (status, body) = http_get(url, &path, &headers, MAX_RESPONSE_BYTES)?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| format!("HTTP {status}: not a JSON answer"))?;
    if !(200..300).contains(&status) || json.get("ok") == Some(&serde_json::Value::Bool(false)) {
        let msg = json
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s.chars().take(200).collect::<String>())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_url::parse_gateway_url;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn builds_fixed_path_with_whitelisted_params() {
        assert_eq!(
            build_path(&AuditParams::default()).unwrap(),
            "/api/admin/audit?limit=100"
        );
        let p = AuditParams {
            action: Some("config.write".into()),
            target_type: Some("config".into()),
            start_date: Some("2026-10-01T00:00:00Z".into()),
            limit: Some(20),
            cursor: Some("abc_DEF-1=".into()),
            ..Default::default()
        };
        assert_eq!(
            build_path(&p).unwrap(),
            "/api/admin/audit?action=config.write&targetType=config&startDate=2026-10-01T00%3A00%3A00Z&limit=20&cursor=abc_DEF-1%3D"
        );
    }

    #[test]
    fn rejects_bad_values() {
        for p in [
            AuditParams {
                action: Some("a b".into()),
                ..Default::default()
            },
            AuditParams {
                action: Some("x\r\nHost: evil".into()),
                ..Default::default()
            },
            AuditParams {
                user_id: Some("".into()),
                ..Default::default()
            },
            AuditParams {
                target_id: Some("a".repeat(200)),
                ..Default::default()
            },
            AuditParams {
                start_date: Some("yesterday".into()),
                ..Default::default()
            },
            AuditParams {
                cursor: Some("a&b".into()),
                ..Default::default()
            },
            AuditParams {
                limit: Some(0),
                ..Default::default()
            },
            AuditParams {
                limit: Some(101),
                ..Default::default()
            },
        ] {
            assert!(build_path(&p).is_err(), "{p:?}");
        }
    }

    #[test]
    fn unknown_params_are_refused() {
        assert!(serde_json::from_str::<AuditParams>(r#"{"limit":5}"#).is_ok());
        assert!(serde_json::from_str::<AuditParams>(r#"{"path":"/api/admin/users"}"#).is_err());
        assert!(serde_json::from_str::<AuditParams>(r#"{"stats":"true"}"#).is_err());
    }

    fn serve_once(status: &'static str, body: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = [0u8; 4096];
            let n = s.read(&mut req).unwrap();
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            s.write_all(resp.as_bytes()).unwrap();
            String::from_utf8_lossy(&req[..n]).to_string()
        });
        (port, h)
    }

    #[test]
    fn sends_bearer_token_to_fixed_path() {
        let (port, h) = serve_once(
            "200 OK",
            r#"{"ok":true,"events":[{"id":"1"}],"nextCursor":null}"#,
        );
        let url = parse_gateway_url(&format!("ws://127.0.0.1:{port}")).unwrap();
        let body = fetch(
            &url,
            Some("tok123"),
            &AuditParams {
                limit: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(body["events"][0]["id"], "1");
        let req = h.join().unwrap();
        assert!(
            req.starts_with("GET /api/admin/audit?limit=5 HTTP/1.1\r\n"),
            "{req}"
        );
        assert!(req.contains("\r\nAuthorization: Bearer tok123\r\n"));
    }

    #[test]
    fn reports_gateway_errors() {
        let (port, h) = serve_once(
            "500 Internal Server Error",
            r#"{"ok":false,"error":"Query failed"}"#,
        );
        let url = parse_gateway_url(&format!("ws://127.0.0.1:{port}")).unwrap();
        assert_eq!(
            fetch(&url, None, &AuditParams::default()).unwrap_err(),
            "Query failed"
        );
        let req = h.join().unwrap();
        assert!(!req.contains("Authorization"));

        let (port, h) = serve_once("401 Unauthorized", "nope");
        let url = parse_gateway_url(&format!("ws://127.0.0.1:{port}")).unwrap();
        assert!(fetch(&url, Some("t"), &AuditParams::default())
            .unwrap_err()
            .contains("401"));
        h.join().unwrap();
    }
}
