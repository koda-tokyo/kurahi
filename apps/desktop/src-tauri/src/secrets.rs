//! Secrets in the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
//!
//! Only the four keys the Control UI stores through `ui/src/ui/secret-storage.ts` are accepted.
//! When no keychain is reachable (for example a Linux session without a Secret Service), values
//! are held in process memory for this run only. They are never written to a plain file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

pub const KEYCHAIN_SERVICE: &str = "com.kodasoken.kurahi";
const MAX_VALUE_BYTES: usize = 8 * 1024;

/// Mirrors `SECRET_STORAGE_KEYS` in ui/src/ui/secret-storage.ts.
pub const ALLOWED_KEYS: [&str; 4] = [
    "KoLo.control.token.v1",
    "KoLo.device.auth.v1",
    "kolo-device-identity-v1",
    "kolo-pair-credential-v1",
];

pub fn validate_key(key: &str) -> Result<&'static str, String> {
    ALLOWED_KEYS
        .iter()
        .copied()
        .find(|k| *k == key)
        .ok_or_else(|| "unknown secret key".to_string())
}

pub fn validate_value(value: &str) -> Result<(), String> {
    if value.len() > MAX_VALUE_BYTES {
        return Err("secret value too large".into());
    }
    Ok(())
}

/// Storage backend, so the command layer is testable without a keychain.
pub trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct KeychainBackend;

impl SecretBackend for KeychainBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[derive(Default)]
pub struct MemoryBackend(Mutex<HashMap<String, String>>);

impl SecretBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(key);
        Ok(())
    }
}

/// The keychain, or session memory when the keychain is unreachable.
pub struct SecretStore {
    backend: Box<dyn SecretBackend>,
    pub persistent: bool,
}

#[derive(Serialize)]
pub struct SecretSnapshot {
    /// False: the OS keychain is unavailable and secrets last only until the app quits.
    pub persistent: bool,
    pub values: HashMap<String, String>,
}

impl SecretStore {
    pub fn new(backend: Box<dyn SecretBackend>, persistent: bool) -> Self {
        SecretStore {
            backend,
            persistent,
        }
    }

    /// Open the OS keychain; fall back to memory if a probe read fails.
    pub fn open() -> Self {
        let keychain = KeychainBackend;
        match keychain.get(ALLOWED_KEYS[0]) {
            Ok(_) => SecretStore::new(Box::new(keychain), true),
            Err(_) => SecretStore::new(Box::new(MemoryBackend::default()), false),
        }
    }

    pub fn get_all(&self) -> SecretSnapshot {
        let mut values = HashMap::new();
        for key in ALLOWED_KEYS {
            if let Ok(Some(v)) = self.backend.get(key) {
                values.insert(key.to_string(), v);
            }
        }
        SecretSnapshot {
            persistent: self.persistent,
            values,
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        let key = validate_key(key)?;
        self.backend.get(key)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let key = validate_key(key)?;
        validate_value(value)?;
        self.backend.set(key, value)
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let key = validate_key(key)?;
        self.backend.delete(key)
    }
}

/// Where the local gateway keeps its shared-secret token: `KOLO_GATEWAY_TOKEN_FILE`, else
/// `<KOLO_HOME>/secrets/gateway.token` (src/gateway/token-file.ts, src/config/kolo-home.ts).
pub fn local_token_path(
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(p) = env("KOLO_GATEWAY_TOKEN_FILE").filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(p.trim()));
    }
    let root = env("KOLO_HOME")
        .or_else(|| env("KOLO_STATE_DIR"))
        .filter(|s| !s.trim().is_empty())
        .map(|s| PathBuf::from(s.trim()))
        .or_else(|| {
            if cfg!(windows) {
                env("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .or_else(|| home.clone().map(|h| h.join("AppData").join("Local")))
                    .map(|b| b.join("KoLo"))
            } else {
                home.clone().map(|h| h.join(".kolo"))
            }
        })?;
    Some(root.join("secrets").join("gateway.token"))
}

/// Validate a token read from disk or pasted by the user.
pub fn validate_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.is_empty() {
        return Err("empty token".into());
    }
    if token.len() > 512 || !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("this does not look like a Kurahi token".into());
    }
    Ok(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_allowlisted() {
        assert!(validate_key("KoLo.control.token.v1").is_ok());
        assert!(validate_key("anything-else").is_err());
        assert!(validate_key("").is_err());
    }

    #[test]
    fn store_round_trip_and_limits() {
        let store = SecretStore::new(Box::new(MemoryBackend::default()), false);
        store.set("KoLo.control.token.v1", "abc").unwrap();
        store.set("kolo-device-identity-v1", "{}").unwrap();
        assert!(store.set("other", "x").is_err());
        assert!(store
            .set("KoLo.device.auth.v1", &"x".repeat(MAX_VALUE_BYTES + 1))
            .is_err());
        let snap = store.get_all();
        assert!(!snap.persistent);
        assert_eq!(snap.values.len(), 2);
        assert_eq!(snap.values["KoLo.control.token.v1"], "abc");
        store.delete("KoLo.control.token.v1").unwrap();
        assert_eq!(store.get_all().values.len(), 1);
        assert!(store.delete("other").is_err());
    }

    #[test]
    fn token_path_resolution() {
        let none = |_: &str| None;
        let home = Some(PathBuf::from("/home/u"));
        if !cfg!(windows) {
            assert_eq!(
                local_token_path(&none, home.clone()).unwrap(),
                PathBuf::from("/home/u/.kolo/secrets/gateway.token")
            );
        }
        let kh = |k: &str| (k == "KOLO_HOME").then(|| "/srv/kh".to_string());
        assert_eq!(
            local_token_path(&kh, home.clone()).unwrap(),
            PathBuf::from("/srv/kh/secrets/gateway.token")
        );
        let tf = |k: &str| (k == "KOLO_GATEWAY_TOKEN_FILE").then(|| "/x/t".to_string());
        assert_eq!(local_token_path(&tf, home).unwrap(), PathBuf::from("/x/t"));
        assert_eq!(local_token_path(&none, None), None);
    }

    #[test]
    fn token_validation() {
        assert_eq!(validate_token("  abc123\n").unwrap(), "abc123");
        assert!(validate_token("").is_err());
        assert!(validate_token("has space").is_err());
        assert!(validate_token(&"a".repeat(600)).is_err());
    }
}
