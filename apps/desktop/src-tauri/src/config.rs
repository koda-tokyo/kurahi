//! Non-secret desktop settings (`desktop.json` in the app config directory): the gateway URL.
//! Tokens are never stored here (see secrets.rs).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gateway_url::{parse_gateway_url, GatewayUrl};

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopConfig {
    #[serde(
        default,
        rename = "gatewayUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub gateway_url: Option<String>,
}

/// Read the config; anything invalid falls back to the default loopback gateway.
pub fn load_gateway(path: &Path) -> GatewayUrl {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopConfig>(&raw).ok())
        .and_then(|c| c.gateway_url)
        .and_then(|u| parse_gateway_url(&u).ok())
        .unwrap_or_default()
}

pub fn save_gateway(path: &Path, url: &GatewayUrl) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let cfg = DesktopConfig {
        gateway_url: Some(url.ws_url()),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_fallback() {
        let dir = std::env::temp_dir().join(format!("kurahi-desktop-cfg-{}", std::process::id()));
        let path = dir.join("desktop.json");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load_gateway(&path), GatewayUrl::default());
        let u = parse_gateway_url("ws://127.0.0.1:18850").unwrap();
        save_gateway(&path, &u).unwrap();
        assert_eq!(load_gateway(&path), u);
        fs::write(&path, r#"{"gatewayUrl":"ws://evil.example:1"}"#).unwrap();
        assert_eq!(load_gateway(&path), GatewayUrl::default());
        fs::write(&path, "not json").unwrap();
        assert_eq!(load_gateway(&path), GatewayUrl::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
