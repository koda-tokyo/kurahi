//! Gateway URL validation. Kurahi Desktop talks only to a gateway on this machine's loopback
//! interface; anything else is rejected before it reaches the webview or the health poller.

use url::{Host, Url};

/// Default gateway port (`DEFAULT_GATEWAY_PORT` in src/config/paths.ts).
pub const DEFAULT_GATEWAY_PORT: u16 = 18789;

/// A validated loopback gateway address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayUrl {
    /// Host as written in URLs: `127.0.0.1`, `localhost` or `[::1]`.
    pub host: String,
    /// Address used for the TCP connection (`localhost` is pinned to 127.0.0.1, never resolved).
    pub connect_host: String,
    pub port: u16,
    pub secure: bool,
}

impl GatewayUrl {
    /// WebSocket URL the Control UI connects to.
    pub fn ws_url(&self) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{}:{}", self.host, self.port)
    }

    /// HTTP base for `/health`.
    pub fn http_base(&self) -> String {
        let scheme = if self.secure { "https" } else { "http" };
        format!("{scheme}://{}:{}", self.host, self.port)
    }
}

impl Default for GatewayUrl {
    fn default() -> Self {
        GatewayUrl {
            host: "127.0.0.1".into(),
            connect_host: "127.0.0.1".into(),
            port: DEFAULT_GATEWAY_PORT,
            secure: false,
        }
    }
}

/// Parse and validate a gateway URL. Accepts `ws` and `http` (TLS is refused in v0.1) with a loopback
/// host (`127.0.0.1`, `localhost`, `::1`); no credentials, query or fragment; path `/` only.
/// A bare `host:port` is read as `ws://host:port`.
pub fn parse_gateway_url(input: &str) -> Result<GatewayUrl, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty URL".into());
    }
    if trimmed.len() > 256 {
        return Err("URL too long".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("ws://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("invalid URL: {e}"))?;
    let secure = match url.scheme() {
        "ws" | "http" => false,
        // Loopback traffic never leaves the machine; the v0.1 health probe speaks plain HTTP.
        "wss" | "https" => {
            return Err("TLS gateway URLs are not supported yet; use ws://127.0.0.1:<port>".into())
        }
        other => return Err(format!("unsupported scheme: {other}")),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in the URL are not allowed".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("query and fragment are not allowed".into());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("a path is not allowed".into());
    }
    let (host, connect_host) = match url.host() {
        Some(Host::Ipv4(ip)) if ip.is_loopback() && ip.octets() == [127, 0, 0, 1] => {
            ("127.0.0.1".to_string(), "127.0.0.1".to_string())
        }
        Some(Host::Ipv6(ip)) if ip.is_loopback() => ("[::1]".to_string(), "::1".to_string()),
        Some(Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => {
            ("localhost".to_string(), "127.0.0.1".to_string())
        }
        _ => return Err("only a gateway on this computer (loopback) is allowed".into()),
    };
    let port = url.port().unwrap_or(DEFAULT_GATEWAY_PORT);
    if port == 0 {
        return Err("invalid port".into());
    }
    Ok(GatewayUrl {
        host,
        connect_host,
        port,
        secure,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_forms() {
        let u = parse_gateway_url("ws://127.0.0.1:18850").unwrap();
        assert_eq!(u.port, 18850);
        assert_eq!(u.ws_url(), "ws://127.0.0.1:18850");
        assert_eq!(u.http_base(), "http://127.0.0.1:18850");

        let u = parse_gateway_url("http://localhost:18789/").unwrap();
        assert_eq!(u.host, "localhost");
        assert_eq!(u.connect_host, "127.0.0.1");

        let u = parse_gateway_url("ws://[::1]:9000").unwrap();
        assert!(!u.secure);
        assert_eq!(u.ws_url(), "ws://[::1]:9000");
        assert_eq!(u.connect_host, "::1");

        let u = parse_gateway_url("127.0.0.1:18851").unwrap();
        assert_eq!(u.ws_url(), "ws://127.0.0.1:18851");
    }

    #[test]
    fn defaults_port() {
        assert_eq!(
            parse_gateway_url("ws://127.0.0.1").unwrap().port,
            DEFAULT_GATEWAY_PORT
        );
        assert_eq!(GatewayUrl::default().ws_url(), "ws://127.0.0.1:18789");
    }

    #[test]
    fn rejects_non_loopback_and_tricks() {
        for bad in [
            "",
            "ws://10.0.0.5:18789",
            "ws://example.com:18789",
            "ws://127.0.0.2:18789",
            "ws://0.0.0.0:18789",
            "ws://localhost.evil.com:1",
            "ws://127.0.0.1.nip.io:1",
            "ws://user:pw@127.0.0.1:1",
            "ws://127.0.0.1:1/path",
            "ws://127.0.0.1:1/?token=x",
            "ws://127.0.0.1:1/#x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://127.0.0.1:21",
            "ws://127.0.0.1:0",
            "ws://127.0.0.1:99999",
            "wss://127.0.0.1:18789",
            "https://localhost:18789",
        ] {
            assert!(parse_gateway_url(bad).is_err(), "should reject {bad:?}");
        }
        assert!(parse_gateway_url(&format!("ws://127.0.0.1:1/{}", "a".repeat(300))).is_err());
    }
}
