import type { GatewayIdentityConfig } from "./types.identity.js";

export type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

export type GatewayTlsConfig = {
  /** Enable TLS for the gateway server. */
  enabled?: boolean;
  /** Auto-generate a self-signed cert if cert/key are missing (default: true). */
  autoGenerate?: boolean;
  /** PEM certificate path for the gateway server. */
  certPath?: string;
  /** PEM private key path for the gateway server. */
  keyPath?: string;
  /** Optional PEM CA bundle for TLS clients (mTLS or custom roots). */
  caPath?: string;
};

export type WideAreaDiscoveryConfig = {
  enabled?: boolean;
  /** Optional unicast DNS-SD domain (e.g. "KoLo.internal"). */
  domain?: string;
};

export type MdnsDiscoveryMode = "off" | "minimal" | "full";

export type MdnsDiscoveryConfig = {
  /**
   * mDNS/Bonjour discovery broadcast mode (default: minimal).
   * - off: disable mDNS entirely
   * - minimal: omit cliPath/sshPort from TXT records
   * - full: include cliPath/sshPort in TXT records
   */
  mode?: MdnsDiscoveryMode;
};

export type DiscoveryConfig = {
  wideArea?: WideAreaDiscoveryConfig;
  mdns?: MdnsDiscoveryConfig;
};

export type CanvasHostConfig = {
  enabled?: boolean;
  /** Directory to serve (default: ~/.kolo/workspace/canvas). */
  root?: string;
  /** HTTP port to listen on (default: 18793). */
  port?: number;
  /** Enable live-reload file watching + WS reloads (default: true). */
  liveReload?: boolean;
};

export type TalkConfig = {
  /** Default ElevenLabs voice ID for Talk mode. */
  voiceId?: string;
  /** Optional voice name -> ElevenLabs voice ID map. */
  voiceAliases?: Record<string, string>;
  /** Default ElevenLabs model ID for Talk mode. */
  modelId?: string;
  /** Default ElevenLabs output format (e.g. mp3_44100_128). */
  outputFormat?: string;
  /** ElevenLabs API key (optional; falls back to ELEVENLABS_API_KEY). */
  apiKey?: string;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/KoLo"). */
  basePath?: string;
  /** Allow token-only auth over insecure HTTP (default: false). */
  allowInsecureAuth?: boolean;
  /** DANGEROUS: Disable device identity checks for the Control UI (default: false). */
  dangerouslyDisableDeviceAuth?: boolean;
  /**
   * Organisation default language for the Control UI (BCP 47, e.g. "ja"). A user's own choice
   * wins; an unsupported value falls back to the OS language.
   */
  defaultLocale?: string;
};

export type GatewayAuthMode = "token" | "password";

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when set. */
  mode?: GatewayAuthMode;
  /**
   * DEPRECATED: shared token inline in config. Prefer `tokenFile`. Used only when no token
   * file exists and KOLO_GATEWAY_TOKEN is unset.
   */
  token?: string;
  /**
   * Path to a 0600 file holding this gateway's token (default `<KOLO_HOME>/secrets/gateway.token`,
   * generated on first start). `false` disables the file source.
   */
  tokenFile?: string | false;
  /** Shared password for password mode (consider env instead). */
  password?: string;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
};

/** Pairing credentials (KoLo 2.0, M3a): invitations, device-bound access + refresh tokens. */
export type GatewayPairingConfig = {
  /** Access token lifetime in minutes (default 60). */
  accessTtlMinutes?: number;
  /** Refresh token family lifetime in days (default 30). */
  refreshTtlDays?: number;
  /** Default invitation lifetime in minutes (default 10, never above 60). */
  inviteTtlMinutes?: number;
  /** Devices paired longer ago than this must pair again (default 90). */
  reconsentDays?: number;
};

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
};

export type GatewayRemoteConfig = {
  /**
   * Serve this gateway beyond loopback (M2a). Default false: a non-loopback `gateway.bind`
   * (lan, tailnet, custom, or a loopback fallback to 0.0.0.0) and Tailscale funnel are refused
   * at startup until this is true. Token or password auth is always required when it is.
   */
  enabled?: boolean;
  /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string;
  /** Transport for macOS remote connections (ssh tunnel or direct WS). */
  transport?: "ssh" | "direct";
  /** Token for remote auth (when the gateway requires token auth). */
  token?: string;
  /** Password for remote auth (when the gateway requires password auth). */
  password?: string;
  /** Expected TLS certificate fingerprint (sha256) for remote gateways. */
  tlsFingerprint?: string;
  /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string;
  /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
};

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
  /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
};

export type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
};

export type GatewayHttpResponsesConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/responses` (OpenResponses API).
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/responses`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /** File inputs (input_file). */
  files?: GatewayHttpResponsesFilesConfig;
  /** Image inputs (input_image). */
  images?: GatewayHttpResponsesImagesConfig;
};

export type GatewayHttpResponsesFilesConfig = {
  /** Allow URL fetches for input_file. Default: true. */
  allowUrl?: boolean;
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per file. Default: 5MB. */
  maxBytes?: number;
  /** Max decoded characters per file. Default: 200k. */
  maxChars?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
  /** PDF handling (application/pdf). */
  pdf?: GatewayHttpResponsesPdfConfig;
};

export type GatewayHttpResponsesPdfConfig = {
  /** Max pages to parse/render. Default: 4. */
  maxPages?: number;
  /** Max pixels per rendered page. Default: 4M. */
  maxPixels?: number;
  /** Minimum extracted text length to skip rasterization. Default: 200 chars. */
  minTextChars?: number;
};

export type GatewayHttpResponsesImagesConfig = {
  /** Allow URL fetches for input_image. Default: true. */
  allowUrl?: boolean;
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpEndpointsConfig = {
  chatCompletions?: GatewayHttpChatCompletionsConfig;
  responses?: GatewayHttpResponsesConfig;
};

export type GatewayHttpConfig = {
  endpoints?: GatewayHttpEndpointsConfig;
};

export type GatewayNodesConfig = {
  /** Browser routing policy for node-hosted browser proxies. */
  browser?: {
    /** Routing mode (default: auto). */
    mode?: "auto" | "manual" | "off";
    /** Pin to a specific node id/name (optional). */
    node?: string;
  };
  /** Additional node.invoke commands to allow on the gateway. */
  allowCommands?: string[];
  /** Commands to deny even if they appear in the defaults or node claims. */
  denyCommands?: string[];
};

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
   * - lan: 0.0.0.0 (all interfaces, no fallback)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 if available (100.64.0.0/10), else loopback
   * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable (requires customBindHost)
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode;
  /** Custom IP address for bind="custom" mode. Fallback: 0.0.0.0. */
  customBindHost?: string;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  pairing?: GatewayPairingConfig;
  /** Enterprise identity: SSO (OIDC, SAML), SCIM provisioning, "SSO required". */
  identity?: GatewayIdentityConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway reads `x-forwarded-for` from the
   * right (skipping these IPs; or `x-real-ip`) to determine the client IP for
   * local pairing, HTTP checks and rate limits.
   */
  trustedProxies?: string[];
  /**
   * Gateway v3 features (Hardening Addendum).
   */
  v3?: {
    /** Enable stream adapter (memory budget + circuit recording). */
    enabled?: boolean;
    /** Enable LeaseManager boot (single-node lease authority). */
    lease?: boolean;
    /** Enable v3 candidate scoring in runWithModelFallback. */
    scoring?: boolean;
    /** Include v3 health snapshot in /health response. */
    health?: boolean;
    /**
     * Per-agent and global memory budget enforcement.
     * Limits are enforced before each request is queued (503 on breach).
     */
    memoryBudget?: {
      /** Total RAM budget for the gateway process in bytes. Default: 1 GB. */
      globalMaxBytes?: number;
      /** Per-agent RAM quota in bytes. Default: globalMaxBytes / expectedAgentCount. */
      perAgentMaxBytes?: number;
      /** Estimated bytes per active request (prompt + response + overhead). Default: 512 KB. */
      estimatedBytesPerRequest?: number;
      /** What to do when a queue is full. Default: "reject-new". */
      rejectionPolicy?: "reject-new" | "oldest-first" | "newest-first";
      /** Expected number of concurrent agents (used to derive per-agent default). Default: 8. */
      expectedAgentCount?: number;
    };
  };
};
