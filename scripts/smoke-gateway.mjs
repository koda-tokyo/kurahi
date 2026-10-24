#!/usr/bin/env node
// Gateway smoke test (KoLo 2.0, M1c). Node only: no bash, no lsof, no curl.
//
//   pnpm smoke [--port N] [--keep] [--timeout SEC]
//
// 1. Fresh state root $HOME/.kolo-test (override: KOLO_SMOKE_HOME, must end in ".kolo-test").
// 2. Minimal kolo.json (one agent "smoke", no channels) + token in <home>/secrets/gateway.token
//    and KOLO_GATEWAY_TOKEN (never argv, never config).
// 3. Start `node dist/entry.js gateway --port N` with KOLO_SKIP_CHANNELS=1.
// 4. Wait for GET /health 200 (deadline 60 s), check `readiness`.
// 5. WebSocket `connect` handshake with the token (expects hello-ok). No chat.send.
// 6. Stop: SIGTERM, wait up to 10 s, then SIGKILL. Port must be free afterwards.
// 6b. API description (M4a): GET /doc without the token is 401; with it, an OpenAPI 3.1.x
//     document with >= 20 operations and the x-kolo-websocket extension.
// 6c. Generated client (M4b): `kolo api health`, `kolo api getOpenApiDocument` and
//     `kolo api ws health` with discovery from <home>/run/gateway.lock + secrets/gateway.token
//     (no port/token env), and a wrong KOLO_GATEWAY_TOKEN must exit 1 with the error model.
// 6d. Pairing (M3a): `kolo pair invite --scope attach` with the owner token, redeem the code
//     with a fresh Ed25519 key (nonce signed), call an observe route and an attach route with
//     the access token, get 403 on an admin route, refresh, replay the retired refresh token
//     (reuse -> family revoked), and `kolo pair devices` must list the device.
// 6e. Sessions (M3b): `kolo api listSessions` (owner token, discovered) answers ok:true with a
//     sessions array, `kolo attach --list --json` prints the same list through the typed client,
//     and an attach credential restricted to a session pattern sees nothing else. After the
//     stop, `kolo agent` against the dead port must exit 3 (no silent embedded fallback).
// 6f. Code Mode + MCP (M6): the smoke config declares the fake stdio MCP server
//     (test/fixtures/mcp/fake-mcp-server.mjs); GET /api/mcp/servers must show it ready with
//     run_command hidden by policy; POST /api/code-mode/run runs one script that calls a core
//     tool (agents_list) and an MCP tool (tools.mcp.fake.add) and returns 42; WS codeMode.run
//     answers the same; `kolo mcp add/test/list/remove` round-trip a second server entry
//     without a gateway in the loop.
// 6g. Plugins + hot reload (M7): the smoke config loads a plugin from <home>/plugins/smoke-plugin;
//     GET /api/plugins lists it loaded and watched, `kolo plugins list --json` (live) agrees, the
//     plugin file is rewritten, POST /api/plugins/smoke-plugin/reload answers ok and
//     `kolo api ws smoke.version` returns the new version from the same gateway process; a broken
//     rewrite is quarantined (listed with its error) and the gateway keeps serving.
// 7. Integrity gate (M2b): `kolo integrity init` registers a one-file constitution before boot,
//    /health must report integrity=ok, and after the run the file is tampered and a second boot
//    must refuse to start with exit code 3.
// Prints one verdict line: "SMOKE PASS ..." or "SMOKE FAIL ...". Exit 0 on pass.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A range clear of the default gateway port (18789) and the ports long-running gateways on a
// dev host usually take right above it; override with --port / KOLO_SMOKE_PORT.
const SMOKE_PORTS = [18860, 18899];
const READY_STATES = new Set(["gateway_ready", "consciousness_ready", "degraded"]);
const FAKE_MCP_SERVER = path.join(ROOT, "test", "fixtures", "mcp", "fake-mcp-server.mjs");

function parseArgs(argv) {
  const opts = { port: undefined, keep: false, timeoutSec: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      opts.port = Number.parseInt(argv[++i] ?? "", 10);
    } else if (a === "--keep") {
      opts.keep = true;
    } else if (a === "--timeout") {
      opts.timeoutSec = Number.parseInt(argv[++i] ?? "", 10) || 60;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  if (process.env.KOLO_SMOKE_PORT && opts.port === undefined) {
    opts.port = Number.parseInt(process.env.KOLO_SMOKE_PORT, 10);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(400, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
        server.close(() => resolve(true)),
      );
    });
  });
}

async function pickPort(requested) {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new Error(`invalid --port ${requested}`);
    }
    if (!(await portFree(requested))) {
      throw new Error(`port ${requested} is in use; pass another --port`);
    }
    return { port: requested, note: "" };
  }
  for (let p = SMOKE_PORTS[0]; p <= SMOKE_PORTS[1]; p++) {
    if (await portFree(p)) {
      return { port: p, note: p === SMOKE_PORTS[0] ? "" : `${SMOKE_PORTS[0]}..${p - 1} busy` };
    }
  }
  throw new Error(`ports ${SMOKE_PORTS.join("-")} all busy; pass --port`);
}

function prepareHome() {
  const home = path.resolve(process.env.KOLO_SMOKE_HOME ?? path.join(os.homedir(), ".kolo-test"));
  if (!path.basename(home).endsWith(".kolo-test")) {
    throw new Error(`refusing to wipe ${home}: smoke home must end in ".kolo-test"`);
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "secrets"), { recursive: true, mode: 0o700 });
  return home;
}

const SMOKE_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function smokePluginSource(version) {
  return [
    "export default {",
    '  id: "smoke-plugin",',
    `  version: "${version}",`,
    "  register(api) {",
    `    api.registerGatewayMethod("smoke.version", ({ respond }) => respond(true, { version: "${version}" }, undefined));`,
    "    api.lifecycle.setInterval(() => {}, 60000);",
    "  },",
    "};",
    "",
  ].join("\n");
}

function writeSmokePlugin(home, version, { broken = false } = {}) {
  const dir = path.join(home, "plugins", "smoke-plugin");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "KoLo.plugin.json"),
    `${JSON.stringify({ id: "smoke-plugin", configSchema: SMOKE_PLUGIN_SCHEMA }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "index.js"),
    broken ? 'throw new Error("smoke plugin deliberately broken");\n' : smokePluginSource(version),
  );
  return dir;
}

function writeConfig(home, port, token) {
  const pluginDir = writeSmokePlugin(home, "v1");
  const config = {
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token" } },
    agents: { list: [{ id: "smoke", default: true }] },
    // M7: one plugin from a load path; hot reload on (explicit reload, watcher debounce short).
    plugins: { load: { paths: [pluginDir] }, hotReload: { debounceMs: 200 } },
    // M2b: a tiny constitution so the boot integrity gate is exercised (enforce mode).
    integrity: { paths: ["constitution/*.md"] },
    // M6: the fake MCP server from the test fixtures, stdio transport.
    mcp: {
      servers: {
        fake: { transport: "stdio", command: process.execPath, args: [FAKE_MCP_SERVER] },
      },
    },
  };
  fs.mkdirSync(path.join(home, "constitution"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "constitution", "SOUL.md"), "# smoke soul\nNever harm.\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(home, "kolo.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(home, "secrets", "gateway.token"), `${token}\n`, { mode: 0o600 });
  // M3b: one idle session for the smoke agent so discovery and attach have something to show.
  const sessionsDir = path.join(home, "agents", "smoke", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    `${JSON.stringify(
      {
        "agent:smoke:main": { sessionId: "smoke-session-1", updatedAt: Date.now(), label: "smoke" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function childEnv(home, port, token) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never inherit a live identity's state, port, unit or token.
    if (!/^(KOLO|CLAWDBOT)_/.test(k) && v !== undefined) {
      env[k] = v;
    }
  }
  return {
    ...env,
    KOLO_HOME: home,
    KOLO_STATE_DIR: home,
    KOLO_CONFIG_PATH: path.join(home, "kolo.json"),
    KOLO_GATEWAY_PORT: String(port),
    KOLO_GATEWAY_TOKEN: token,
    KOLO_SKIP_CHANNELS: "1",
    CLAWDBOT_SKIP_CHANNELS: "1",
    KOLO_SERVICE_ID: "smoke",
    NO_COLOR: "1",
  };
}

async function waitHealth(port, deadlineMs, child, token) {
  let last = "no response";
  while (Date.now() < deadlineMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`gateway exited early (code=${child.exitCode} signal=${child.signalCode})`);
    }
    try {
      // Poll anonymously (the public body is {status, version, uptime}); polling with the
      // token would count against the credential-attempt limiter. Once up, read the full
      // picture (readiness, integrity) with the token exactly once.
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) {
        if (!token) {
          return body;
        }
        const deep = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
          headers: { Authorization: `Bearer ${token}` },
        });
        if (deep.status !== 200) {
          throw new Error(`/health with token: HTTP ${deep.status}`);
        }
        return await deep.json();
      }
      last = `HTTP ${res.status} readiness=${body.readiness ?? "?"}`;
    } catch (err) {
      last = err?.name === "TimeoutError" ? "timeout" : "unreachable";
    }
    // 1.5 s between probes: the HTTP rate limiter counts anonymous probes per source, and a
    // slow boot on a loaded machine must not turn into 429s.
    await sleep(1500);
  }
  throw new Error(`/health not 200 before deadline (${last})`);
}

async function protocolVersion() {
  try {
    const mod = await import(
      pathToFileURL(path.join(ROOT, "dist/gateway/protocol/schema/protocol-schemas.js")).href
    );
    return mod.PROTOCOL_VERSION ?? 3;
  } catch {
    return 3;
  }
}

async function wsHandshake(port, token) {
  if (typeof WebSocket !== "function") {
    return "skipped (no global WebSocket)";
  }
  const version = await protocolVersion();
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("ws connect: no hello-ok within 10s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: "smoke-connect",
          method: "connect",
          params: {
            minProtocol: version,
            maxProtocol: version,
            client: {
              id: "kolo-probe",
              version: "smoke",
              platform: process.platform,
              mode: "probe",
            },
            auth: { token },
          },
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type !== "res" || frame.id !== "smoke-connect") {
        return;
      }
      clearTimeout(timer);
      ws.close();
      if (frame.ok && frame.payload?.type === "hello-ok") {
        resolve(`hello-ok(protocol ${frame.payload.protocol ?? version})`);
      } else {
        reject(
          new Error(`ws connect rejected: ${JSON.stringify(frame.error ?? frame).slice(0, 300)}`),
        );
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws connect: socket error"));
    });
  });
}

async function checkApiDoc(port, token) {
  const unauth = await fetch(`http://127.0.0.1:${port}/doc`, { signal: AbortSignal.timeout(5000) });
  if (unauth.status !== 401) {
    throw new Error(`/doc without token: HTTP ${unauth.status} (want 401)`);
  }
  const res = await fetch(`http://127.0.0.1:${port}/doc`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) {
    throw new Error(`/doc: HTTP ${res.status} (want 200)`);
  }
  const doc = await res.json();
  if (typeof doc.openapi !== "string" || !/^3\.1\.\d+$/.test(doc.openapi)) {
    throw new Error(`/doc: openapi=${JSON.stringify(doc.openapi)} (want 3.1.x)`);
  }
  let ops = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    ops += Object.keys(item).length;
  }
  if (ops < 20) {
    throw new Error(`/doc: ${ops} operations (want >= 20)`);
  }
  const wsMethods = Number(doc["x-kolo-websocket"]?.methods?.length ?? 0);
  if (wsMethods === 0) {
    throw new Error("/doc: x-kolo-websocket lists no methods");
  }
  return `openapi ${doc.openapi}, ${ops} ops, ${wsMethods} ws methods`;
}

async function stopGateway(child, port) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "already exited";
  }
  const t0 = Date.now();
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  child.kill("SIGTERM");
  let result = await Promise.race([exited, sleep(10_000).then(() => null)]);
  let how = "SIGTERM";
  if (!result) {
    child.kill("SIGKILL");
    how = "SIGKILL";
    result = await Promise.race([exited, sleep(5_000).then(() => null)]);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  for (let i = 0; i < 20 && !(await portFree(port)); i++) {
    await sleep(250);
  }
  if (!(await portFree(port))) {
    throw new Error(`port ${port} still busy after stop (${how})`);
  }
  return `${how}(${secs}s, code=${result?.code ?? "?"}${result?.signal ? ` signal=${result.signal}` : ""})`;
}

function tailFile(file, bytes) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
  } catch {
    return "";
  }
}

function runCli(entry, args, env, timeoutMs = 60_000, keepChars = 4000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const take = (b) => {
      out = (out + b.toString("utf8")).slice(-keepChars);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

// stdout and stderr are captured together, so the JSON document can follow log lines, and a
// log line such as "[supply-chain] warning: …" also starts with "[". Take the first line start
// from which the rest of the output parses.
function parseJsonOutput(out) {
  let lastError = null;
  for (const match of out.matchAll(/^[{[]/gm)) {
    try {
      return JSON.parse(out.slice(match.index));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `no JSON in output${lastError ? ` (${lastError.message})` : ""}: ${out.slice(-300)}`,
  );
}

async function checkApiCli(entry, home, port, token) {
  const env = childEnv(home, port, token);
  // Discovery path: the CLI must find the port in the lease and the token in the 0600 file.
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const health = await runCli(entry, ["api", "health", "--raw"], env);
  if (health.code !== 0) {
    throw new Error(`kolo api health: exit ${health.code}: ${health.out.slice(-300)}`);
  }
  const body = parseJsonOutput(health.out);
  if (!READY_STATES.has(body.readiness)) {
    throw new Error(`kolo api health: readiness=${body.readiness ?? "missing"}`);
  }
  const doc = await runCli(entry, ["api", "getOpenApiDocument", "--raw"], env, 60_000, 4_000_000);
  if (doc.code !== 0 || !String(parseJsonOutput(doc.out).openapi).startsWith("3.1.")) {
    throw new Error(`kolo api getOpenApiDocument: exit ${doc.code}: ${doc.out.slice(-300)}`);
  }
  const ws = await runCli(entry, ["api", "ws", "health", "--raw"], env);
  if (ws.code !== 0) {
    throw new Error(`kolo api ws health: exit ${ws.code}: ${ws.out.slice(-300)}`);
  }
  parseJsonOutput(ws.out);
  const denied = await runCli(entry, ["api", "getOpenApiDocument", "--raw"], {
    ...env,
    KOLO_GATEWAY_TOKEN: "wrong-token",
  });
  const err = denied.code === 1 ? parseJsonOutput(denied.out) : null;
  if (!err || err.ok !== false || err.status !== 401) {
    throw new Error(
      `kolo api with a wrong token: exit ${denied.code} (want 1 + 401): ${denied.out.slice(-300)}`,
    );
  }
  return "health+doc+ws ok, 401->exit 1";
}

// Tamper with the registered file and expect the gateway to refuse to start (exit 3).
async function checkIntegrityRefusal(entry, home, port, token) {
  const soul = path.join(home, "constitution", "SOUL.md");
  const original = fs.readFileSync(soul);
  fs.appendFileSync(soul, "tampered\n");
  try {
    const res = await runCli(
      entry,
      ["gateway", "--port", String(port)],
      childEnv(home, port, token),
      60_000,
    );
    if (res.code !== 3) {
      throw new Error(
        `tampered constitution: gateway exit=${res.code} signal=${res.signal} (want 3): ${res.out.slice(-300)}`,
      );
    }
    if (!(await portFree(port))) {
      throw new Error(`tampered constitution: port ${port} bound after refusal`);
    }
    return "refused(exit 3)";
  } finally {
    fs.writeFileSync(soul, original);
  }
}

// ── Pairing round trip (M3a) ─────────────────────────────────────────────────────────────
function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    publicKey: raw.toString("base64url"),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    privateKey,
  };
}

function proof(key, purpose, nonce, secret) {
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");
  const payload = `kolo-pair-v1|${purpose}|${nonce}|${digest}`;
  return sign(null, Buffer.from(payload, "utf8"), key.privateKey).toString("base64url");
}

async function pairCall(port, pathname, { token, body, method } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function checkPairing(entry, home, port, token) {
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const invite = await runCli(
    entry,
    ["pair", "invite", "--scope", "attach", "--ttl", "5m", "--label", "smoke", "--json"],
    env,
  );
  if (invite.code !== 0) {
    throw new Error(`kolo pair invite: exit ${invite.code}: ${invite.out.slice(-300)}`);
  }
  const code = parseJsonOutput(invite.out).code;
  if (typeof code !== "string" || !code.startsWith("kpi_")) {
    throw new Error("kolo pair invite: no code in output");
  }
  const key = deviceKey();
  const nonce = async () => (await pairCall(port, "/api/pair/nonce")).json.nonce;
  const n1 = await nonce();
  const redeemed = await pairCall(port, "/api/pair/redeem", {
    body: {
      code,
      deviceKeyPub: key.publicKey,
      deviceName: "smoke-device",
      nonce: n1,
      signature: proof(key, "redeem", n1, code),
    },
  });
  if (redeemed.status !== 200 || redeemed.json.device?.scope !== "attach") {
    throw new Error(
      `redeem: HTTP ${redeemed.status} ${JSON.stringify(redeemed.json).slice(0, 200)}`,
    );
  }
  const { accessToken, refreshToken } = redeemed.json;
  const me = await pairCall(port, "/api/pair/me", { token: accessToken });
  if (me.status !== 200 || me.json.principal?.scope !== "attach") {
    throw new Error(`/api/pair/me with access token: HTTP ${me.status}`);
  }
  const tools = await pairCall(port, "/tools/invoke", { token: accessToken, body: {} });
  if (tools.status !== 400) {
    throw new Error(
      `/tools/invoke with attach token: HTTP ${tools.status} (want 400: gate passed, body rejected)`,
    );
  }
  const admin = await pairCall(port, "/api/pair/invite", {
    token: accessToken,
    body: { scope: "observe" },
  });
  if (admin.status !== 403) {
    throw new Error(`/api/pair/invite with attach token: HTTP ${admin.status} (want 403)`);
  }
  const n2 = await nonce();
  const rotated = await pairCall(port, "/api/pair/refresh", {
    body: { refreshToken, nonce: n2, signature: proof(key, "refresh", n2, refreshToken) },
  });
  if (rotated.status !== 200 || rotated.json.generation !== 1) {
    throw new Error(
      `refresh: HTTP ${rotated.status} ${JSON.stringify(rotated.json).slice(0, 200)}`,
    );
  }
  if ((await pairCall(port, "/api/pair/me", { token: accessToken })).status !== 401) {
    throw new Error("old access token still accepted after refresh");
  }
  const n3 = await nonce();
  const reuse = await pairCall(port, "/api/pair/refresh", {
    body: { refreshToken, nonce: n3, signature: proof(key, "refresh", n3, refreshToken) },
  });
  if (reuse.status !== 401 || reuse.json.error !== "reuse_detected") {
    throw new Error(
      `refresh replay: HTTP ${reuse.status} ${JSON.stringify(reuse.json).slice(0, 200)} (want 401 reuse_detected)`,
    );
  }
  if ((await pairCall(port, "/api/pair/me", { token: rotated.json.accessToken })).status !== 401) {
    throw new Error("family still alive after reuse detection");
  }
  const devices = await runCli(entry, ["pair", "devices", "--json"], env);
  const listed = devices.code === 0 ? parseJsonOutput(devices.out).devices : null;
  if (
    !Array.isArray(listed) ||
    !listed.some((d) => d.fingerprint === key.fingerprint && d.families?.active === 0)
  ) {
    throw new Error(`kolo pair devices: exit ${devices.code}: ${devices.out.slice(-300)}`);
  }
  const credentials = path.join(home, "secrets", "credentials.json");
  const mode = fs.statSync(credentials).mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o600) {
    throw new Error(`credentials.json mode ${mode.toString(8)} (want 600)`);
  }
  const raw = fs.readFileSync(credentials, "utf8");
  for (const secret of [code, accessToken, refreshToken, rotated.json.accessToken]) {
    if (raw.includes(secret)) {
      throw new Error("credentials.json holds a clear-text secret");
    }
  }
  return "invite+redeem+scopes(403)+refresh+reuse-revoke ok, credentials.json 0600 hashed";
}

// ── Session discovery + attach (M3b) ─────────────────────────────────────────────────────
async function checkSessions(entry, home, port, token) {
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const api = await runCli(entry, ["api", "listSessions", "--raw"], env);
  if (api.code !== 0) {
    throw new Error(`kolo api listSessions: exit ${api.code}: ${api.out.slice(-300)}`);
  }
  const listed = parseJsonOutput(api.out);
  if (
    listed.ok !== true ||
    !Array.isArray(listed.sessions) ||
    !listed.sessions.some((s) => s.key === "agent:smoke:main" && s.agent === "smoke")
  ) {
    throw new Error(`kolo api listSessions: unexpected body ${api.out.slice(-200)}`);
  }
  const one = await runCli(entry, ["api", "getSession", "-p", "id=smoke", "--raw"], env);
  if (one.code !== 0 || parseJsonOutput(one.out).session?.key !== "agent:smoke:main") {
    throw new Error(`kolo api getSession id=smoke: exit ${one.code}: ${one.out.slice(-300)}`);
  }
  const attach = await runCli(entry, ["attach", "--list", "--json"], env);
  if (attach.code !== 0) {
    throw new Error(`kolo attach --list: exit ${attach.code}: ${attach.out.slice(-300)}`);
  }
  const viaAttach = parseJsonOutput(attach.out).sessions;
  if (!Array.isArray(viaAttach) || viaAttach.length !== listed.sessions.length) {
    throw new Error(
      `kolo attach --list: ${Array.isArray(viaAttach) ? viaAttach.length : "?"} sessions, api listed ${listed.sessions.length}`,
    );
  }
  // Attach read-only to the agent's main session over WS for 1.5 s, then detach cleanly.
  const attached = await runCli(
    entry,
    ["attach", "smoke", "--follow", "--duration", "1500", "--history", "0", "--json"],
    env,
    60_000,
  );
  const attachLine = attached.out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{") && l.includes('"attached"'));
  const attachEvt = attachLine ? JSON.parse(attachLine) : null;
  if (
    attached.code !== 0 ||
    attachEvt?.session?.key !== "agent:smoke:main" ||
    attachEvt?.mode !== "follow"
  ) {
    throw new Error(
      `kolo attach smoke --follow: exit ${attached.code}: ${attached.out.slice(-300)}`,
    );
  }
  const afterDetach = await pairCall(port, "/api/sessions/agent:smoke:main", { token });
  if (afterDetach.status !== 200 || afterDetach.json.session?.clients !== 0) {
    throw new Error(
      `clients after detach: HTTP ${afterDetach.status} clients=${afterDetach.json.session?.clients} (want 0)`,
    );
  }
  // A restricted attach credential: invitation with a sessions allowlist that matches nothing.
  const invite = await pairCall(port, "/api/pair/invite", {
    token,
    body: { scope: "attach", sessions: ["agent:nobody:*"], label: "smoke-restricted" },
  });
  if (invite.status !== 201 || !Array.isArray(invite.json.invitation?.sessions)) {
    throw new Error(`invite with sessions allowlist: HTTP ${invite.status}`);
  }
  const key = deviceKey();
  const n = (await pairCall(port, "/api/pair/nonce")).json.nonce;
  const redeemed = await pairCall(port, "/api/pair/redeem", {
    body: {
      code: invite.json.code,
      deviceKeyPub: key.publicKey,
      deviceName: "smoke-restricted",
      nonce: n,
      signature: proof(key, "redeem", n, invite.json.code),
    },
  });
  if (redeemed.status !== 200) {
    throw new Error(`redeem restricted: HTTP ${redeemed.status}`);
  }
  const restricted = await pairCall(port, "/api/sessions", { token: redeemed.json.accessToken });
  if (restricted.status !== 200 || restricted.json.sessions?.length !== 0) {
    throw new Error(
      `restricted listSessions: HTTP ${restricted.status} ${JSON.stringify(restricted.json).slice(0, 200)} (want 200 with no sessions)`,
    );
  }
  const unseen = listed.sessions[0]?.key ?? "agent:smoke:main";
  const get = await pairCall(port, `/api/sessions/${encodeURIComponent(unseen)}`, {
    token: redeemed.json.accessToken,
  });
  if (get.status !== 404) {
    throw new Error(`restricted getSession: HTTP ${get.status} (want 404)`);
  }
  return `api listSessions=${listed.sessions.length}+getSession, attach --list + follow/detach ok, allowlist(200 empty, 404)`;
}

// ── Code Mode + MCP (M6) ─────────────────────────────────────────────────────────────────
async function checkCodeMode(entry, home, port, token) {
  // The gateway connected to the fixture at boot (supervised, background): wait for ready.
  let servers = [];
  for (let i = 0; i < 40; i++) {
    const res = await pairCall(port, "/api/mcp/servers", { token });
    if (res.status !== 200) {
      throw new Error(`/api/mcp/servers: HTTP ${res.status}`);
    }
    servers = res.json.servers ?? [];
    if (servers.some((s) => s.id === "fake" && s.state === "ready")) {
      break;
    }
    await sleep(250);
  }
  const fake = servers.find((s) => s.id === "fake");
  if (fake?.state !== "ready") {
    throw new Error(
      `mcp server fake: state=${fake?.state ?? "missing"} err=${fake?.lastError ?? ""}`,
    );
  }
  const hidden = fake.tools.find((t) => t.name === "run_command");
  if (!hidden || hidden.exposed !== false) {
    throw new Error("mcp policy: run_command should be hidden by default");
  }
  const script =
    "const a = await tools.agents_list({}); const r = await tools.mcp.fake.add({ a: 2, b: 40 });" +
    " console.log('ok'); return { sum: r.details.sum, agents: a.text.length > 0, keys: Object.keys(tools.mcp.fake).length };";
  const run = await pairCall(port, "/api/code-mode/run", { token, body: { script } });
  if (run.status !== 200 || run.json.ok !== true || run.json.value?.sum !== 42) {
    throw new Error(
      `code-mode run: HTTP ${run.status} ${JSON.stringify(run.json).slice(0, 300)} (want ok + sum 42)`,
    );
  }
  if (run.json.toolCalls !== 2 || run.json.calls?.[1]?.tool !== "mcp:fake:add") {
    throw new Error(`code-mode calls: ${JSON.stringify(run.json.calls).slice(0, 200)}`);
  }
  const unauth = await pairCall(port, "/api/code-mode/run", { body: { script: "return 1;" } });
  if (unauth.status !== 401) {
    throw new Error(`code-mode without token: HTTP ${unauth.status} (want 401)`);
  }
  const limit = await pairCall(port, "/api/code-mode/run", {
    token,
    body: { script: "while (true) {}", timeoutMs: 1000 },
  });
  if (limit.json.ok !== false || limit.json.error?.code !== "timeout") {
    throw new Error(`code-mode timeout: ${JSON.stringify(limit.json).slice(0, 200)}`);
  }
  // Same script through the typed client / WS.
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const ws = await runCli(
    entry,
    [
      "api",
      "ws",
      "codeMode.run",
      JSON.stringify({ script: "return (await tools.mcp.fake.add({ a: 1, b: 1 })).details.sum;" }),
      "--raw",
    ],
    env,
  );
  if (ws.code !== 0 || parseJsonOutput(ws.out).value !== 2) {
    throw new Error(`kolo api ws codeMode.run: exit ${ws.code}: ${ws.out.slice(-300)}`);
  }
  // `kolo mcp list` reads the config and asks the running gateway for live state.
  const list = await runCli(entry, ["mcp", "list", "--json"], env, 60_000, 400_000);
  const listed = list.code === 0 ? parseJsonOutput(list.out) : null;
  if (
    !listed ||
    listed.gateway !== true ||
    !listed.servers.some((s) => s.id === "fake" && s.state === "ready" && s.tools === "5/6")
  ) {
    throw new Error(`kolo mcp list: exit ${list.code}: ${list.out.slice(-300)}`);
  }
  return `mcp fake ready (${fake.tools.filter((t) => t.exposed).length}/${fake.tools.length} tools), script agents_list+mcp.fake.add=42, 401, timeout, ws ok, kurahi mcp list live`;
}

async function checkPlugins(entry, home, port, token) {
  const list = await pairCall(port, "/api/plugins", { token });
  if (list.status !== 200 || list.json.ok !== true) {
    throw new Error(`/api/plugins: HTTP ${list.status} ${JSON.stringify(list.json).slice(0, 200)}`);
  }
  const row = (list.json.plugins ?? []).find((p) => p.id === "smoke-plugin");
  if (!row || row.status !== "loaded" || row.quarantined) {
    throw new Error(
      `smoke-plugin: ${JSON.stringify(row ?? "missing").slice(0, 300)} (want loaded)`,
    );
  }
  if (!row.gatewayMethods.includes("smoke.version")) {
    throw new Error(`smoke-plugin gateway methods: ${JSON.stringify(row.gatewayMethods)}`);
  }
  if (list.json.hotReload?.enabled !== true || list.json.hotReload?.watching !== true) {
    throw new Error(
      `hot reload state: ${JSON.stringify(list.json.hotReload)} (want enabled + watching)`,
    );
  }
  const unauth = await pairCall(port, "/api/plugins");
  if (unauth.status !== 401) {
    throw new Error(`/api/plugins without token: HTTP ${unauth.status} (want 401)`);
  }
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  // The live list carries every bundled plugin: keep the whole output, not the default tail.
  const cli = await runCli(entry, ["plugins", "list", "--json"], env, 60_000, 400_000);
  if (cli.code !== 0) {
    throw new Error(`kolo plugins list: exit ${cli.code}: ${cli.out.slice(-300)}`);
  }
  const cliJson = parseJsonOutput(cli.out);
  const cliRow = (cliJson.plugins ?? []).find((p) => p.id === "smoke-plugin");
  if (!cliJson.live || cliRow?.status !== "loaded" || cliRow?.reloads !== 0) {
    throw new Error(`kolo plugins list (live): ${JSON.stringify(cliRow ?? cliJson).slice(0, 300)}`);
  }
  const v1 = await runCli(entry, ["api", "ws", "smoke.version", "{}", "--raw"], env);
  if (v1.code !== 0 || parseJsonOutput(v1.out).version !== "v1") {
    throw new Error(`smoke.version before reload: exit ${v1.code}: ${v1.out.slice(-200)}`);
  }
  // Rewrite the plugin and reload it in place.
  writeSmokePlugin(home, "v2");
  const reload = await pairCall(port, "/api/plugins/smoke-plugin/reload", {
    token,
    method: "POST",
  });
  if (reload.status !== 200 || reload.json.plugin?.ok !== true) {
    throw new Error(`reload: HTTP ${reload.status} ${JSON.stringify(reload.json).slice(0, 300)}`);
  }
  const v2 = await runCli(entry, ["api", "ws", "smoke.version", "{}", "--raw"], env);
  if (v2.code !== 0 || parseJsonOutput(v2.out).version !== "v2") {
    throw new Error(`smoke.version after reload: exit ${v2.code}: ${v2.out.slice(-200)} (want v2)`);
  }
  // A broken rewrite is quarantined: listed with its error, gateway still answers.
  writeSmokePlugin(home, "v3", { broken: true });
  const broken = await pairCall(port, "/api/plugins/smoke-plugin/reload", {
    token,
    method: "POST",
  });
  if (
    broken.status !== 200 ||
    broken.json.plugin?.ok !== false ||
    broken.json.plugin?.status !== "error"
  ) {
    throw new Error(
      `broken reload: HTTP ${broken.status} ${JSON.stringify(broken.json).slice(0, 300)}`,
    );
  }
  const after = await pairCall(port, "/api/plugins", { token });
  const qrow = (after.json.plugins ?? []).find((p) => p.id === "smoke-plugin");
  if (
    qrow?.status !== "error" ||
    qrow?.quarantined !== true ||
    !String(qrow?.error).includes("deliberately broken")
  ) {
    throw new Error(`quarantine: ${JSON.stringify(qrow).slice(0, 300)}`);
  }
  const health = await pairCall(port, "/health", { token });
  if (health.status !== 200) {
    throw new Error(`health after quarantine: HTTP ${health.status}`);
  }
  writeSmokePlugin(home, "v4");
  const fixed = await pairCall(port, "/api/plugins/smoke-plugin/reload", { token, method: "POST" });
  if (fixed.json.plugin?.ok !== true) {
    throw new Error(`reload after fix: ${JSON.stringify(fixed.json).slice(0, 300)}`);
  }
  const v4 = await runCli(entry, ["api", "ws", "smoke.version", "{}", "--raw"], env);
  if (v4.code !== 0 || parseJsonOutput(v4.out).version !== "v4") {
    throw new Error(`smoke.version after fix: ${v4.out.slice(-200)} (want v4)`);
  }
  return `loaded+watched, kurahi plugins list live, reload v1->v2 ok, broken->quarantined (gateway up), fixed->v4 (reloads ${fixed.json.plugin.reloads})`;
}

// `kolo mcp add|test|remove` need no gateway (test probes in-process); run them after the stop so
// the config writes do not trigger the live gateway's config-reload restart mid-smoke.
async function checkMcpCli(entry, home, port, token) {
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const add = await runCli(
    entry,
    [
      "mcp",
      "add",
      "fake2",
      "--stdio",
      process.execPath,
      "--allow",
      "echo,run_*",
      "--json",
      "--",
      FAKE_MCP_SERVER,
    ],
    env,
    60_000,
    400_000,
  );
  if (add.code !== 0 || parseJsonOutput(add.out).server?.transport !== "stdio") {
    throw new Error(`kolo mcp add: exit ${add.code}: ${add.out.slice(-300)}`);
  }
  const test = await runCli(entry, ["mcp", "test", "fake2", "--json"], env, 60_000, 400_000);
  const probed = test.code === 0 ? parseJsonOutput(test.out) : null;
  if (
    !probed ||
    probed.state !== "ready" ||
    !probed.tools.some((t) => t.name === "run_command" && t.exposed === true) ||
    !probed.tools.some((t) => t.name === "add" && t.exposed === false) ||
    probed.resources?.length !== 1 ||
    probed.prompts?.length !== 1
  ) {
    throw new Error(`kolo mcp test fake2: exit ${test.code}: ${test.out.slice(-300)}`);
  }
  const remove = await runCli(entry, ["mcp", "remove", "fake2", "--json"], env, 60_000, 400_000);
  if (remove.code !== 0) {
    throw new Error(`kolo mcp remove: exit ${remove.code}: ${remove.out.slice(-300)}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "kolo.json"), "utf8"));
  if (cfg.mcp?.servers?.fake2 !== undefined || cfg.mcp?.servers?.fake === undefined) {
    throw new Error("kolo mcp remove: config not updated as expected");
  }
  return "add+test(exec-like allowed by glob, 1 resource, 1 prompt)+remove ok";
}

// With the gateway stopped, `kolo agent` must refuse (exit 3, naming state dir and port) and
// never fall back to the embedded agent on its own (M3b).
async function checkAgentRefusal(entry, home, port, token) {
  const env = childEnv(home, port, token);
  delete env.KOLO_GATEWAY_PORT;
  delete env.KOLO_GATEWAY_TOKEN;
  const refusal = await runCli(
    entry,
    ["agent", "--agent", "smoke", "--message", "ping", "--timeout", "5"],
    env,
    60_000,
  );
  if (
    refusal.code !== 3 ||
    !/gateway unreachable/.test(refusal.out) ||
    !refusal.out.includes(home) ||
    !refusal.out.includes(String(port))
  ) {
    throw new Error(
      `kolo agent without a gateway: exit ${refusal.code} (want 3 + "gateway unreachable" + state dir + port): ${refusal.out.slice(-300)}`,
    );
  }
  return "no-gateway exit 3";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const entry = path.join(ROOT, "dist", "entry.js");
  if (!fs.existsSync(entry)) {
    throw new Error("dist/entry.js missing; run pnpm build first");
  }
  const { port, note } = await pickPort(opts.port);
  const home = prepareHome();
  const token = randomBytes(24).toString("hex");
  writeConfig(home, port, token);
  const init = await runCli(entry, ["integrity", "init", "--yes"], childEnv(home, port, token));
  if (init.code !== 0) {
    throw new Error(`kolo integrity init failed (exit ${init.code}): ${init.out.slice(-300)}`);
  }

  const logFile = path.join(home, "smoke.log");
  const log = fs.openSync(logFile, "a", 0o600);
  const t0 = Date.now();
  const child = spawn(process.execPath, [entry, "gateway", "--port", String(port)], {
    cwd: home,
    env: childEnv(home, port, token),
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let stopInfo = "not started";
  try {
    const health = await waitHealth(port, t0 + opts.timeoutSec * 1000, child, token);
    const anon = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    const anonKeys = Object.keys(anon).sort().join(",");
    if (anonKeys !== "status,uptime,version") {
      throw new Error(`anonymous /health leaks keys: ${anonKeys}`);
    }
    const bootSecs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!READY_STATES.has(health.readiness)) {
      throw new Error(`readiness=${health.readiness ?? "missing"} (want gateway_ready)`);
    }
    if (health.integrity !== "ok") {
      throw new Error(`integrity=${health.integrity ?? "missing"} (want ok)`);
    }
    const ws = await wsHandshake(port, token);
    const apiDoc = await checkApiDoc(port, token);
    const apiCli = await checkApiCli(entry, home, port, token);
    const pairing = await checkPairing(entry, home, port, token);
    const sessions = await checkSessions(entry, home, port, token);
    const codeMode = await checkCodeMode(entry, home, port, token);
    const plugins = await checkPlugins(entry, home, port, token);
    stopInfo = await stopGateway(child, port);
    const mcpCli = await checkMcpCli(entry, home, port, token);
    const agentRefusal = await checkAgentRefusal(entry, home, port, token);
    const gate = await checkIntegrityRefusal(entry, home, port, token);
    console.log(
      `SMOKE PASS port=${port}${note ? ` (${note})` : ""} boot=${bootSecs}s health=200 readiness=${health.readiness} integrity=${health.integrity} ws=${String(ws)} doc=(${String(apiDoc)}) api=(${String(apiCli)}) pair=(${String(pairing)}) sessions=(${String(sessions)}) codeMode=(${String(codeMode)}) plugins=(${plugins}) stop=${stopInfo} mcpCli=(${mcpCli}) agent=(${agentRefusal}) gate=${gate}`,
    );
  } catch (err) {
    try {
      stopInfo = await stopGateway(child, port);
    } catch (stopErr) {
      stopInfo = String(stopErr.message ?? stopErr);
    }
    process.stderr.write(`--- gateway log tail (${logFile}) ---\n${tailFile(logFile, 2000)}\n`);
    console.log(`SMOKE FAIL port=${port} ${err.message ?? err} stop=${stopInfo}`);
    process.exitCode = 1;
  } finally {
    fs.closeSync(log);
    if (!opts.keep && process.exitCode !== 1) {
      // The state root holds the gateway token and whatever the run created; do not leave it around.
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.log(`SMOKE FAIL ${err.message ?? err}`);
  process.exit(1);
});
