import type { Tab } from "./navigation";
import { connectGateway } from "./app-gateway";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import {
  applySettings,
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings";
import { takeInviteFragment } from "./demo-invite-link";
import { handlePairLink } from "./pair-link";
import { fetchSsoConfig, takeEnrollFragment, takeSsoFragment, type SsoConfig } from "./sso";

type LifecycleHost = {
  basePath: string;
  tab: Tab;
  chatHasAutoScrolled: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
};

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  // Private demo: a `#invite=kdi_…` link is the visitor's sign-in. It replaces any stored token
  // and wins over a stored phone credential below.
  const inviteCode = takeInviteFragment();
  if (inviteCode) {
    const settingsHost = host as unknown as Parameters<typeof applySettings>[0];
    applySettings(settingsHost, { ...settingsHost.settings, token: inviteCode });
  }
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  // M16: a `#pair=` link from `kolo connect web` (or a stored phone credential) supplies the
  // token before the first connection; otherwise connect as before.
  const gatewayHost = host as unknown as Parameters<typeof connectGateway>[0];
  // Organisation sign-in: `#sso_code=` from the gateway's SSO callback (exchanged for the session
  // token before the first connection), and the providers to offer.
  const ssoReady = takeSsoFragment();
  // An identity admin's enrollment link (`#kurahi_enroll=`): set up a passkey or an app.
  const enrollCode = takeEnrollFragment();
  if (enrollCode !== undefined) {
    (host as unknown as { passkeyEnrollCode: string | null }).passkeyEnrollCode = enrollCode;
  }
  void fetchSsoConfig(window.location.origin).then((config) => {
    (host as unknown as { ssoConfig: SsoConfig | null }).ssoConfig = config;
  });
  let pairNotice: string | null = null;
  void ssoReady.then((sso) => {
    pairNotice = sso.notice;
    if (inviteCode) {
      connectGateway(gatewayHost);
      return;
    }
    return handlePairLink({
      useToken: (token) => {
        const settingsHost = host as unknown as Parameters<typeof applySettings>[0];
        applySettings(settingsHost, { ...settingsHost.settings, token });
        connectGateway(gatewayHost);
      },
      notify: (message) => {
        pairNotice = message;
        (host as unknown as { lastError: string | null }).lastError = message;
      },
    }).then((tookOver) => {
      if (!tookOver) {
        connectGateway(gatewayHost);
        if (pairNotice) {
          (host as unknown as { lastError: string | null }).lastError = pairNotice;
        }
      }
    });
  });
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
