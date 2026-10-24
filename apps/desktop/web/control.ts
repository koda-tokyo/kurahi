// Desktop entry for the bundled Control UI: install the keychain-backed secret storage, then
// load the unchanged Control UI. Secrets never touch localStorage in this build.
import { installHostAuditFetcher } from "../../../ui/src/ui/controllers/enterprise";
import { installSecretStorage } from "../../../ui/src/ui/secret-storage";
import { desktopApi } from "./desktop-api";
import { createKeychainStorage } from "./keychain-storage";

const storage = await createKeychainStorage(desktopApi, window.localStorage);
installSecretStorage(storage.backend);
// The webview is another origin than the gateway; the audit API is read through Rust instead of
// widening the gateway's CORS policy.
installHostAuditFetcher((params) => desktopApi.auditFetch(params));
await import("../../../ui/src/main.ts");
