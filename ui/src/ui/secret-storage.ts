// Where the Control UI keeps secrets: the gateway token, device-auth tokens, the device identity
// (Ed25519 private key) and the pairing credential.
//
// The browser build keeps using window.localStorage, exactly as before. A host that has a real
// secret store (Kurahi Desktop: the OS keychain) installs its own backend before the app module
// loads; the UI then never writes those values to localStorage.
//
// The interface is synchronous on purpose: the call sites (loadSettings, loadDeviceAuthToken, …)
// are synchronous, so an external backend preloads its values into memory and writes through.

export type SecretStorageBackend = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Every key the UI stores through this module. A host backend may reject anything else. */
export const SECRET_STORAGE_KEYS = {
  gatewayToken: "KoLo.control.token.v1",
  deviceAuth: "KoLo.device.auth.v1",
  deviceIdentity: "kolo-device-identity-v1",
  pairCredential: "kolo-pair-credential-v1",
} as const;

const localStorageBackend: SecretStorageBackend = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

let external: SecretStorageBackend | null = null;

/** Install a host secret store (call before the app module is imported). */
export function installSecretStorage(backend: SecretStorageBackend | null): void {
  external = backend;
}

/** True when a host secret store is installed (secrets must stay out of localStorage). */
export function hasExternalSecretStorage(): boolean {
  return external !== null;
}

export function secretStorage(): SecretStorageBackend {
  return external ?? localStorageBackend;
}
