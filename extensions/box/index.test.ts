import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileScanner } from "../../src/security/scanner.js";
import { flushAudit } from "../../src/audit/audit-log.js";
import {
  buildAuthorizeUrl,
  type ConnectorAuditSink,
  ConnectorRuntime,
  RateLimiter,
  revokeToken,
} from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import {
  type AttachmentIntakeInput,
  INBOX_ATTACHMENTS_DIR,
  intakeAttachment,
} from "../../src/security/attachment-intake.js";
import { createBoxToolsFor, probeBox } from "./index.js";
import {
  BOX_API,
  BOX_ENDPOINTS,
  BOX_UPLOAD,
  buildClient,
  configProblems,
  readSettings,
  requestedScopes,
  SCOPES,
} from "./src/config.js";
import { uploadBody } from "./src/tools.js";

// Recorded Box API responses only; files go through the real attachment intake with a fake
// scanner, inside a temporary Project.
const CLIENT_ID = "abcdefghijklmnopqrstuvwxyz012345";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-box-"));
const home = path.join(tmpRoot, "state");
const folder = path.join(tmpRoot, "client");
const prev = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
let sessionKey = "";
let verdict: "clean" | "infected" = "clean";
const scanner: FileScanner = {
  name: "clamav",
  async scan() {
    return {
      verdict,
      scanner: "clamav",
      signature: verdict === "infected" ? "Eicar" : null,
      detail: null,
      ms: 1,
    };
  },
};
const intakeInputs: AttachmentIntakeInput[] = [];
const intake = (input: AttachmentIntakeInput) => {
  intakeInputs.push(input);
  return intakeAttachment(input, {
    scanner,
    config: {
      scanner: "clamav",
      requireScan: true,
      scanTimeoutMs: 2000,
      extractTimeoutMs: 60_000,
      extractMaxOldSpaceMb: 256,
    },
  });
};

beforeAll(() => {
  process.env.KOLO_HOME = home;
  process.env.KOLO_STATE_DIR = home;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "report.txt"), "四半期レポート");
  fs.writeFileSync(path.join(folder, "tool.exe"), "MZ\u0090\u0000");
  const project = createProject(
    {
      name: "Client",
      folder,
      rules: { readOnly: [], writable: [INBOX_ATTACHMENTS_DIR] },
      mode: "act",
    },
    { createdBy: "owner", home },
  );
  sessionKey = projectSessionKey("main", project.id, "c1");
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", prev.home],
    ["KOLO_STATE_DIR", prev.state],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setup(
  config: Record<string, unknown>,
  routes: Route[],
  opts: { grant?: string[]; key?: string; searchLimiter?: RateLimiter } = {},
) {
  const settings = readSettings({ clientId: CLIENT_ID, ...config });
  const client = buildClient(settings, "box-secret")!;
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const audit: Parameters<ConnectorAuditSink>[0][] = [];
  const runtime = new ConnectorRuntime(
    { id: "box", client },
    {
      secrets: () => secrets,
      fetch,
      sleep: noSleep,
      random: () => 0,
      audit: (r) => void audit.push(r),
    },
  );
  runtime.tokens.save({
    accessToken: "box-at",
    refreshToken: "box-rt",
    expiresAt: Date.now() + 3_600_000,
    scopes: opts.grant ?? client.scopes,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  let answer: "allow" | "deny" = "deny";
  const asks: unknown[] = [];
  const tools = createBoxToolsFor(
    settings,
    runtime,
    { agentId: "main", sessionKey: opts.key ?? sessionKey },
    async (p) => {
      asks.push(p);
      return answer;
    },
    { intake, searchLimiter: opts.searchLimiter },
  );
  const tool = (name: string) => (params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("c", params) as Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  return { runtime, tools, tool, fetch, audit, asks, allow: () => void (answer = "allow") };
}

describe("box configuration", () => {
  it("is read-only by default; uploads need one non-root folder", () => {
    expect(requestedScopes(readSettings({ clientId: CLIENT_ID }))).toEqual([SCOPES.read]);
    expect(
      configProblems(readSettings({ clientId: CLIENT_ID, write: { upload: true } }), "s"),
    ).toContain("write.uploadFolderId must be the numeric id of the folder uploads go to");
    expect(
      configProblems(
        readSettings({ clientId: CLIENT_ID, write: { upload: true, uploadFolderId: "0" } }),
        "s",
      ),
    ).toContain("write.uploadFolderId must not be the root folder (0)");
    expect(buildClient(readSettings({ clientId: CLIENT_ID }), undefined)).toBeUndefined();
    expect(setup({}, []).tools.map((t) => t.name)).toEqual([
      "box_search",
      "box_file_metadata",
      "box_file_fetch",
    ]);
    expect(
      setup({ write: { upload: true, uploadFolderId: "12345" } }, []).tools.map((t) => t.name),
    ).toContain("box_file_upload");
  });

  it("authorizes with the read scope and revokes with the client credentials", async () => {
    const client = buildClient(readSettings({ clientId: CLIENT_ID }), "box-secret")!;
    const url = new URL(
      buildAuthorizeUrl(client, {
        redirectUri: "http://localhost:5000/callback",
        state: "s",
        challenge: "c",
      }),
    );
    expect(url.origin + url.pathname).toBe(BOX_ENDPOINTS.authorizeUrl);
    expect(url.searchParams.get("scope")).toBe("root_readonly");
    const fetch = mockFetch([
      on("POST", BOX_ENDPOINTS.revokeUrl, () => new Response(null, { status: 200 })),
    ]);
    await revokeToken(client, "box-rt", { fetch, sleep: noSleep });
    const form = new URLSearchParams(fetch.calls[0].body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("token")]).toEqual([
      CLIENT_ID,
      "box-secret",
      "box-rt",
    ]);
  });
});

describe("box read tools", () => {
  it("searches files only, bounded, inside configured folders; audits ids only", async () => {
    const { tool, fetch, audit } = setup({ searchFolderIds: ["111", "222", "bad"] }, [
      on("GET", `${BOX_API}/search?`, () =>
        jsonResponse({
          entries: [
            {
              id: "9001",
              type: "file",
              name: "契約書.pdf",
              size: 1234,
              path_collection: { entries: [{ name: "All Files" }, { name: "法務" }] },
            },
          ],
          total_count: 1,
        }),
      ),
    ]);
    const res = await tool("box_search")({ query: '"秘密保持契約"', limit: 500, offset: 20_000 });
    const u = new URL(fetch.calls[0].url);
    expect(u.searchParams.get("type")).toBe("file");
    expect(u.searchParams.get("limit")).toBe("50");
    expect(u.searchParams.get("offset")).toBe("10000");
    expect(u.searchParams.get("ancestor_folder_ids")).toBe("111,222");
    expect(fetch.calls[0].headers.authorization).toBe("Bearer box-at");
    expect(res.content[0].text).toContain("path: /法務");
    expect(res.content[0].text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(audit[0].detail).toMatchObject({ op: "files.search", ids: ["9001"], count: 1 });
    expect(JSON.stringify(audit)).not.toMatch(/契約|法務/);
  });

  it("waits on the search limiter before each search", async () => {
    let acquired = 0;
    const limiter = new RateLimiter(50, 60_000);
    const orig = limiter.acquire.bind(limiter);
    limiter.acquire = async () => {
      acquired += 1;
      return orig();
    };
    const { tool } = setup(
      {},
      [on("GET", `${BOX_API}/search?`, () => jsonResponse({ entries: [] }))],
      {
        searchLimiter: limiter,
      },
    );
    await tool("box_search")({ query: "x" });
    expect(acquired).toBe(1);
  });

  it("refuses malformed ids and a missing scope before any request", async () => {
    const { tool, fetch } = setup({}, []);
    expect((await tool("box_file_metadata")({ id: "../users/me" })).content[0].text).toMatch(
      /^Error: bad_request/,
    );
    expect(fetch.calls).toHaveLength(0);
    const noScope = setup({}, [], { grant: [] });
    expect((await noScope.tool("box_search")({ query: "x" })).content[0].text).toMatch(
      /^Error: scope_missing/,
    );
    expect(noScope.fetch.calls).toHaveLength(0);
  });

  it("fetches a clean file into the Project: path and text, never bytes", async () => {
    verdict = "clean";
    const { tool, fetch, audit } = setup({}, [
      on("GET", `${BOX_API}/files/9002?`, () =>
        jsonResponse({ id: "9002", name: "議事録.txt", size: 21, file_version: { id: "777" } }),
      ),
      on("GET", `${BOX_API}/files/9002/content`, () => new Response("議事録の本文")),
    ]);
    const res = await tool("box_file_fetch")({ id: "9002" });
    expect(fetch.calls[1].url).toBe(`${BOX_API}/files/9002/content`);
    expect(res.details?.attachment).toMatchObject({ status: "accepted", fileId: "9002" });
    const stored = (res.details!.attachment as { path: string }).path;
    expect(stored.startsWith(`${INBOX_ATTACHMENTS_DIR}/`)).toBe(true);
    expect(fs.readFileSync(path.join(folder, stored), "utf8")).toBe("議事録の本文");
    expect(res.content[0].text).toContain("議事録の本文");
    expect(res.content[0].text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(intakeInputs.at(-1)).toMatchObject({
      connector: "box",
      messageId: "9002",
      attachmentId: "777",
    });
    expect(JSON.stringify(audit)).not.toContain("議事録");
  });

  it("refuses an infected file and an oversize file (the latter without downloading)", async () => {
    verdict = "infected";
    const bad = setup({}, [
      on("GET", `${BOX_API}/files/9003?`, () =>
        jsonResponse({ id: "9003", name: "x.txt", size: 5 }),
      ),
      on("GET", `${BOX_API}/files/9003/content`, () => new Response("virus")),
    ]);
    const r = await bad.tool("box_file_fetch")({ id: "9003" });
    expect(r.details?.attachment).toMatchObject({ status: "refused", code: "infected" });
    verdict = "clean";
    const big = setup({}, [
      on("GET", `${BOX_API}/files/9004?`, () =>
        jsonResponse({ id: "9004", name: "big.pdf", size: 50 * 1024 * 1024 }),
      ),
    ]);
    const r2 = await big.tool("box_file_fetch")({ id: "9004" });
    expect(r2.details?.attachment).toMatchObject({ status: "refused", code: "too_large" });
    expect(big.fetch.calls).toHaveLength(1);
  });

  it("works only in a Project chat and reports a file Box is still preparing", async () => {
    const outside = setup({}, [], { key: "agent:main:main" });
    expect((await outside.tool("box_file_fetch")({ id: "9005" })).content[0].text).toMatch(
      /^Error: unsupported/,
    );
    expect(outside.fetch.calls).toHaveLength(0);
    const pending = setup({}, [
      on("GET", `${BOX_API}/files/9006?`, () =>
        jsonResponse({ id: "9006", name: "a.txt", size: 3 }),
      ),
      on(
        "GET",
        `${BOX_API}/files/9006/content`,
        () => new Response(null, { status: 202, headers: { "retry-after": "10" } }),
      ),
    ]);
    expect((await pending.tool("box_file_fetch")({ id: "9006" })).content[0].text).toMatch(
      /^Error: provider_unavailable/,
    );
  });

  it("probe reads the signed-in user's id", async () => {
    const { runtime, fetch } = setup({}, [
      on("GET", `${BOX_API}/users/me?`, () => jsonResponse({ id: "1" })),
    ]);
    await probeBox(runtime);
    expect(fetch.calls[0].url).toBe(`${BOX_API}/users/me?fields=id`);
  });
});

describe("box upload", () => {
  const cfg = { write: { upload: true, uploadFolderId: "12345" } };

  it("builds multipart with attributes before the file", () => {
    const { body, contentType } = uploadBody(
      "a.txt",
      "12345",
      Buffer.from("hi"),
      "text/plain",
      "B",
    );
    const text = Buffer.from(body).toString("utf8");
    expect(contentType).toBe("multipart/form-data; boundary=B");
    expect(text.indexOf('name="attributes"')).toBeLessThan(text.indexOf('name="file"'));
    expect(text).toContain('{"name":"a.txt","parent":{"id":"12345"}}');
  });

  it("uploads to the configured folder only after approval, with root_readwrite", async () => {
    const s = setup(cfg, [
      on("POST", BOX_UPLOAD, () =>
        jsonResponse({ total_count: 1, entries: [{ id: "8001", name: "report.txt" }] }, 201),
      ),
    ]);
    expect((await s.tool("box_file_upload")({ path: "report.txt" })).content[0].text).toMatch(
      /^Error: approval_denied/,
    );
    expect(s.fetch.calls).toHaveLength(0);
    s.allow();
    const ok = await s.tool("box_file_upload")({ path: "report.txt" });
    expect(ok.content[0].text).toContain("as file 8001; not shared");
    const sent = s.fetch.calls[0];
    expect(sent.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent.bytes?.toString("utf8")).toContain('"parent":{"id":"12345"}');
    expect(s.asks[0]).toMatchObject({ tool: "box_file_upload", ruleId: "connector:box:write" });
    expect(s.audit.at(-1)?.detail).toMatchObject({
      op: "files.upload",
      ids: ["8001"],
      kind: "txt",
    });
    expect(JSON.stringify(s.audit)).not.toContain("report");
  });

  it("refuses executables, paths outside the Project, and a grant without root_readwrite", async () => {
    const s = setup(cfg, []);
    s.allow();
    expect((await s.tool("box_file_upload")({ path: "tool.exe" })).content[0].text).toMatch(
      /^Error: unsupported/,
    );
    expect((await s.tool("box_file_upload")({ path: "../outside.txt" })).content[0].text).toMatch(
      /^Error: bad_request/,
    );
    const ro = setup(cfg, [], { grant: [SCOPES.read] });
    ro.allow();
    expect((await ro.tool("box_file_upload")({ path: "report.txt" })).content[0].text).toMatch(
      /^Error: scope_missing/,
    );
    expect([...s.fetch.calls, ...ro.fetch.calls]).toHaveLength(0);
    expect(ro.asks).toHaveLength(0);
  });
});
