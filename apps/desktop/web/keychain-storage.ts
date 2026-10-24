// OS-keychain backend for the Control UI secret storage (ui/src/ui/secret-storage.ts).
//
// The UI's storage calls are synchronous, so the values are preloaded from the keychain once,
// kept in memory, and every change is written through to the keychain in order.
import type { SecretStorageBackend } from "../../../ui/src/ui/secret-storage";
import { SECRET_STORAGE_KEYS } from "../../../ui/src/ui/secret-storage";
import type { DesktopApi } from "./desktop-api";

export type KeychainStorage = {
  backend: SecretStorageBackend;
  /** False when no OS keychain is reachable: secrets last until the app quits. */
  persistent: boolean;
  /** Resolves when every queued keychain write has finished. */
  flush(): Promise<void>;
};

type StorageLike = Pick<Storage, "getItem" | "removeItem">;

export async function createKeychainStorage(
  api: Pick<DesktopApi, "secretGetAll" | "secretSet" | "secretDelete">,
  legacy?: StorageLike,
  onError: (err: unknown) => void = (err) => console.error("keychain write failed", err),
): Promise<KeychainStorage> {
  const snapshot = await api.secretGetAll();
  const values = new Map(Object.entries(snapshot.values ?? {}));
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>) => {
    queue = queue.then(op).catch(onError);
  };

  const backend: SecretStorageBackend = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (values.get(key) === value) {
        return;
      }
      values.set(key, value);
      enqueue(() => api.secretSet(key, value));
    },
    removeItem: (key) => {
      if (!values.has(key)) {
        return;
      }
      values.delete(key);
      enqueue(() => api.secretDelete(key));
    },
  };

  // Secrets that a browser-mode build left in this webview's localStorage move to the keychain.
  if (legacy) {
    for (const key of Object.values(SECRET_STORAGE_KEYS)) {
      const old = legacy.getItem(key);
      if (old != null) {
        if (!values.has(key)) {
          backend.setItem(key, old);
        }
        legacy.removeItem(key);
      }
    }
  }

  return { backend, persistent: snapshot.persistent, flush: () => queue };
}
