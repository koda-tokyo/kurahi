//! Gateway health: a GET of `/health` on the loopback gateway, parsed into a tray state.
//!
//! The probe is a minimal HTTP/1.1 client over `std::net` (loopback only, short timeouts,
//! byte-capped response). No HTTP plugin and no extra network stack.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

use crate::gateway_url::GatewayUrl;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const IO_TIMEOUT: Duration = Duration::from_millis(3000);

/// Tray colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayState {
    Green,
    Amber,
    Red,
}

/// What the probe saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayCondition {
    /// `/health` answered `healthy`.
    Running,
    /// `/health` answered `degraded`, or something the probe did not recognise.
    Attention,
    /// `/health` answered `unhealthy` (HTTP 503).
    Unhealthy,
    /// Nothing listening, or no HTTP answer.
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthSnapshot {
    pub condition: GatewayCondition,
    pub tray: TrayState,
    /// Raw `status` field from `/health`, if any.
    pub status: Option<String>,
    pub version: Option<String>,
    pub http_status: Option<u16>,
}

impl HealthSnapshot {
    pub fn stopped() -> Self {
        HealthSnapshot {
            condition: GatewayCondition::Stopped,
            tray: TrayState::Red,
            status: None,
            version: None,
            http_status: None,
        }
    }
}

pub fn tray_state(condition: GatewayCondition) -> TrayState {
    match condition {
        GatewayCondition::Running => TrayState::Green,
        GatewayCondition::Attention => TrayState::Amber,
        GatewayCondition::Unhealthy | GatewayCondition::Stopped => TrayState::Red,
    }
}

/// Map an HTTP status and `/health` body to a snapshot.
pub fn parse_health(http_status: u16, body: &str) -> HealthSnapshot {
    let json: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let field = |name: &str| {
        json.as_ref()
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(64).collect::<String>())
    };
    let status = field("status");
    let version = field("version");
    let condition = match (http_status, status.as_deref()) {
        (200, Some("healthy")) | (200, Some("ok")) => GatewayCondition::Running,
        (503, _) | (_, Some("unhealthy")) => GatewayCondition::Unhealthy,
        _ => GatewayCondition::Attention,
    };
    HealthSnapshot {
        condition,
        tray: tray_state(condition),
        status,
        version,
        http_status: Some(http_status),
    }
}

/// Split a raw HTTP/1.1 response into (status code, body). Handles Content-Length and chunked.
pub fn parse_http_response(raw: &[u8]) -> Option<(u16, String)> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.split_whitespace();
    let proto = parts.next()?;
    if !proto.starts_with("HTTP/1.") {
        return None;
    }
    let code: u16 = parts.next()?.parse().ok()?;
    let chunked = lines.any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body = if chunked {
        dechunk(body)?
    } else {
        body.to_string()
    };
    Some((code, body))
}

fn dechunk(mut rest: &str) -> Option<String> {
    let mut out = String::new();
    loop {
        let (size_line, after) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(out);
        }
        if after.len() < size {
            return None;
        }
        out.push_str(after.get(..size)?);
        rest = after.get(size..)?.strip_prefix("\r\n")?;
    }
}

fn socket_addr(url: &GatewayUrl) -> Option<SocketAddr> {
    // connect_host is always a literal loopback address (see gateway_url.rs), never a name.
    (url.connect_host.as_str(), url.port)
        .to_socket_addrs()
        .ok()?
        .find(|a| a.ip().is_loopback())
}

/// One GET to the loopback gateway. `path_and_query` must start with `/` and is built by the
/// caller from fixed parts; `headers` are extra request headers. The response is byte-capped.
pub fn http_get(
    url: &GatewayUrl,
    path_and_query: &str,
    headers: &[(&str, &str)],
    max_bytes: usize,
) -> Result<(u16, String), String> {
    if !path_and_query.starts_with('/') || path_and_query.contains(['\r', '\n', ' ']) {
        return Err("invalid request path".into());
    }
    for (name, value) in headers {
        if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
            return Err("invalid header".into());
        }
    }
    let addr = socket_addr(url).ok_or_else(|| "gateway address not resolvable".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|_| "gateway not reachable".to_string())?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut request = format!(
        "GET {path_and_query} HTTP/1.1\r\nHost: {}:{}\r\nAccept: application/json\r\nUser-Agent: kurahi-desktop/{}\r\nConnection: close\r\n",
        url.host,
        url.port,
        env!("CARGO_PKG_VERSION")
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "gateway write failed".to_string())?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > max_bytes {
                    return Err("gateway response too large".into());
                }
            }
            Err(_) => break,
        }
    }
    parse_http_response(&buf).ok_or_else(|| "invalid HTTP response".to_string())
}

/// Probe `/health`. Never panics; any failure is `Stopped`.
pub fn probe(url: &GatewayUrl) -> HealthSnapshot {
    match http_get(url, "/health", &[], MAX_RESPONSE_BYTES) {
        Ok((code, body)) => parse_health(code, &body),
        Err(_) => HealthSnapshot::stopped(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn maps_status_to_tray() {
        let h = parse_health(200, r#"{"status":"healthy","version":"2.0.3","uptime":5}"#);
        assert_eq!(h.condition, GatewayCondition::Running);
        assert_eq!(h.tray, TrayState::Green);
        assert_eq!(h.version.as_deref(), Some("2.0.3"));

        let h = parse_health(200, r#"{"status":"degraded"}"#);
        assert_eq!(h.tray, TrayState::Amber);
        assert_eq!(h.condition, GatewayCondition::Attention);

        let h = parse_health(503, r#"{"status":"unhealthy"}"#);
        assert_eq!(h.tray, TrayState::Red);
        assert_eq!(h.condition, GatewayCondition::Unhealthy);

        assert_eq!(parse_health(200, "not json").tray, TrayState::Amber);
        assert_eq!(parse_health(401, "{}").tray, TrayState::Amber);
        assert_eq!(
            parse_health(200, r#"{"status":"ok"}"#).tray,
            TrayState::Green
        );
        assert_eq!(tray_state(GatewayCondition::Stopped), TrayState::Red);
    }

    #[test]
    fn truncates_long_fields() {
        let long = "x".repeat(500);
        let h = parse_health(200, &format!(r#"{{"status":"{long}"}}"#));
        assert_eq!(h.status.unwrap().len(), 64);
    }

    #[test]
    fn parses_http_responses() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"status\":\"healthy\"}";
        assert_eq!(
            parse_http_response(raw),
            Some((200, "{\"status\":\"healthy\"}".into()))
        );

        let raw = b"HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n3\r\n12}\r\n0\r\n\r\n";
        assert_eq!(parse_http_response(raw), Some((503, "{\"a\":12}".into())));

        assert_eq!(parse_http_response(b"garbage"), None);
        assert_eq!(parse_http_response(b"SSH-2.0-OpenSSH\r\n\r\n"), None);
    }

    #[test]
    fn probes_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let n = s.read(&mut req).unwrap();
            let req = String::from_utf8_lossy(&req[..n]).to_string();
            let body = r#"{"status":"degraded","version":"2.0.3"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            s.write_all(resp.as_bytes()).unwrap();
            req
        });
        let url = crate::gateway_url::parse_gateway_url(&format!("ws://127.0.0.1:{port}")).unwrap();
        let h = probe(&url);
        assert_eq!(h.tray, TrayState::Amber);
        assert_eq!(h.version.as_deref(), Some("2.0.3"));
        let req = server.join().unwrap();
        assert!(req.starts_with("GET /health HTTP/1.1\r\n"));
    }

    #[test]
    fn closed_port_is_stopped() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = crate::gateway_url::parse_gateway_url(&format!("ws://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(&url), HealthSnapshot::stopped());
    }
}
