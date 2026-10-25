import type { AddressInfo } from "node:net";
// Business connectors: authorization code + PKCE over a loopback redirect (RFC 8252 §7.3).
//
// A one-shot HTTP listener on 127.0.0.1 (random port unless one is configured) receives the
// redirect, checks `state`, answers a static page and closes. The wait is bounded.
import http from "node:http";
import { ConnectorError } from "./errors.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  type OAuthClientConfig,
  type OAuthDeps,
  randomState,
  type TokenSet,
} from "./oauth.js";

export type LoopbackOptions = {
  /** Port to listen on; 0 picks a free one. Microsoft and Google accept any localhost port. */
  port?: number;
  /** Host name written into redirect_uri. Microsoft registers `http://localhost`; Google `127.0.0.1`. */
  redirectHost?: "localhost" | "127.0.0.1";
  path?: string;
  timeoutMs?: number;
  nonce?: string;
  /** Called with the URL to open in a browser (the CLI prints it and tries to open it). */
  openUrl: (url: string) => void | Promise<void>;
};

const PAGE = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;margin:3rem"><p>${title}</p><p>You can close this window.</p>`;

export type LoopbackCallback = { code: string; redirectUri: string; verifier: string };

/** Run the browser step only: returns the code and the values needed to redeem it. */
export async function awaitLoopbackCode(
  client: OAuthClientConfig,
  opts: LoopbackOptions,
): Promise<LoopbackCallback> {
  const pkce = createPkcePair();
  const state = randomState();
  const cbPath = opts.path ?? "/callback";
  const timeoutMs = Math.min(opts.timeoutMs ?? 300_000, 900_000);
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new ConnectorError(
              "bad_request",
              `port ${opts.port} is already in use on this machine; choose another redirectPort and register the matching callback URL`,
            )
          : err,
      ),
    );
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${opts.redirectHost ?? "localhost"}:${port}${cbPath}`;

  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ConnectorError("timeout", "sign-in was not completed in time"));
    }, timeoutMs);
    timer.unref?.();
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method !== "GET" || url.pathname !== cbPath) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string) => {
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(PAGE(title));
      };
      if (url.searchParams.get("state") !== state) {
        // A request without our state is not our redirect; keep waiting for the real one.
        finish(400, "Sign-in request not recognised.");
        return;
      }
      clearTimeout(timer);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        finish(400, "Sign-in was not completed.");
        reject(
          new ConnectorError(
            error === "access_denied"
              ? "approval_denied"
              : error === "consent_required"
                ? "consent_required"
                : "bad_request",
            `authorization failed: ${error ?? "no code"}`,
          ),
        );
        return;
      }
      finish(200, "Sign-in complete.");
      resolve(code);
    });
  });
  // Observed here so a timeout that fires while openUrl is still running is not unhandled.
  result.catch(() => {});

  try {
    const url = buildAuthorizeUrl(client, {
      redirectUri,
      state,
      challenge: pkce.challenge,
      nonce: opts.nonce,
    });
    await opts.openUrl(url);
    const code = await result;
    return { code, redirectUri, verifier: pkce.verifier };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Full loopback sign-in: browser step, then the code is redeemed with the PKCE verifier. */
export async function loopbackSignIn(
  client: OAuthClientConfig,
  opts: LoopbackOptions,
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const cb = await awaitLoopbackCode(client, opts);
  return exchangeAuthorizationCode(client, cb, deps);
}
