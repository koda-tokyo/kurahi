import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GuardianConfig } from "../../config/types.guardian.js";
import { runEngineToolAsync } from "../../autopilot/engine-tools.js";
import { parseHibpDomain } from "./breaches.js";
import { codeQueries } from "./code.js";
import {
  type ExposureDeps,
  type ExposureResolver,
  type HttpGet,
  type HttpResponse,
  isValidDomain,
  maskValue,
  recordAttestation,
  sha256Hex,
  verifyDomains,
  verifyTxtRecord,
} from "./common.js";
import {
  crawlSites,
  detectSecrets,
  extractLinks,
  parseRobots,
  plausibleCredential,
} from "./crawl.js";
import {
  checkDnsPosture,
  dmarcPolicy,
  findDanglingCnames,
  judgePosture,
  takeoverProne,
} from "./dns.js";
import { lookalikeDomains, splitDomain } from "./lookalikes.js";
import { diffSubdomains, parseCrtSh, readInventory } from "./subdomains.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-exposure-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let homes = 0;
const newHome = () => {
  const h = path.join(root, `home${++homes}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
};

// ---- stubs (no network in tests) ----------------------------------------------------------------

type Answer = unknown[] | string; // a string is an error code
function stubResolver(table: Record<string, Answer>): ExposureResolver {
  const q = (type: string) => async (host: string) => {
    const a = table[`${type} ${host}`];
    if (typeof a === "string") {
      throw Object.assign(new Error(a), { code: a });
    }
    if (a === undefined) {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
    return a as never;
  };
  return {
    resolveTxt: q("TXT"),
    resolveMx: q("MX"),
    resolveCaa: q("CAA"),
    resolveCname: q("CNAME"),
    resolveNs: q("NS"),
    resolve4: q("A"),
    resolve6: q("AAAA"),
  };
}

type Page = Partial<HttpResponse> | Error;
function stubHttp(pages: Record<string, Page>) {
  const calls: string[] = [];
  const http: HttpGet = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (p instanceof Error) {
      throw p;
    }
    if (!p) {
      return { status: 404, headers: {}, body: "", truncated: false };
    }
    return {
      status: p.status ?? 200,
      headers: p.headers ?? { "content-type": "text/html" },
      body: p.body ?? "",
      truncated: p.truncated ?? false,
    };
  };
  return { http, calls };
}

const noSleep = async () => undefined;

function deps(home: string, over: Partial<ExposureDeps> = {}): ExposureDeps {
  return {
    home,
    resolver: stubResolver({}),
    http: stubHttp({}).http,
    sleep: noSleep,
    secret: () => undefined,
    now: () => new Date("2026-10-31T00:00:00Z"),
    ...over,
  };
}

const parse = (text: string) => {
  const lines = text.split("\n");
  const facts = Object.fromEntries(
    lines
      .filter((l) => l.startsWith("fact "))
      .map((l) => {
        const kv = l.slice(5);
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
  );
  return { facts, verdict: lines.at(-1)!, text };
};

async function run(
  name: string,
  guardian: GuardianConfig,
  home: string,
  over: Partial<ExposureDeps> = {},
) {
  return parse(
    await runEngineToolAsync(
      name,
      {},
      { projectId: "pexp", home, guardian, exposure: deps(home, over) },
    ),
  );
}

const enabled = (extra: Record<string, unknown> = {}): GuardianConfig => ({
  exposure: { enabled: true, domains: ["example.co.jp"], ...extra },
});

// ---- domains, verification, masking --------------------------------------------------------------

describe("exposure basics", () => {
  it("validates domains and masks values to first 2 + last 2", () => {
    expect(isValidDomain("example.co.jp")).toBe(true);
    expect(isValidDomain("*.example.com")).toBe(false);
    expect(isValidDomain("Example.com")).toBe(false);
    expect(maskValue("hunter2-hospital")).toBe("hu…al");
    expect(maskValue("short")).toBe("***");
  });

  it("verifies a domain by its TXT token or an attestation", async () => {
    const home = newHome();
    const record = verifyTxtRecord(home);
    expect(record).toMatch(/^kurahi-exposure-verify=[a-f0-9]{32}$/);
    const resolver = stubResolver({
      "TXT good.example.com": [[record.slice(0, 20), record.slice(20)]],
      "TXT bad.example.com": [["kurahi-exposure-verify=0000"]],
      "TXT down.example.com": "ESERVFAIL",
    });
    recordAttestation(home, "attested.example.com", "admin:sato");
    const v = await verifyDomains(
      ["good.example.com", "bad.example.com", "down.example.com", "attested.example.com"],
      { home, resolver },
    );
    expect(v.map((x) => [x.domain, x.verified, x.method])).toEqual([
      ["good.example.com", true, "dns-txt"],
      ["bad.example.com", false, null],
      ["down.example.com", false, null],
      ["attested.example.com", true, "attestation"],
    ]);
    expect(v[2].error).toBe("ESERVFAIL");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(home, "guardian", "exposure", "verify.json")).mode & 0o777).toBe(
        0o600,
      );
    }
  });
});

// ---- fail closed ---------------------------------------------------------------------------------

describe("exposure engine checks fail closed", () => {
  const names = [
    "guardian_exposure_subdomains",
    "guardian_exposure_dns",
    "guardian_exposure_web_secrets",
    "guardian_exposure_lookalikes",
    "guardian_exposure_breaches",
    "guardian_exposure_code",
    "guardian_exposure_people",
  ];

  it("escalates when exposure or Guardian is not enabled, or no domain is declared", async () => {
    const home = newHome();
    for (const n of names) {
      expect((await run(n, {}, home)).verdict).toMatch(/^verdict ESCALATE .*not enabled/);
      expect((await run(n, { enabled: false, ...enabled() }, home)).verdict).toMatch(
        /^verdict ESCALATE Guardian is disabled/,
      );
    }
    const none = await run("guardian_exposure_dns", { exposure: { enabled: true } }, home);
    expect(none.verdict).toMatch(/no domains are declared/);
  });

  it("an unverified domain escalates and nothing is fetched", async () => {
    const home = newHome();
    const { http, calls } = stubHttp({});
    for (const n of names.slice(0, 4)) {
      const r = await run(n, enabled(), home, { http });
      expect(r.verdict).toMatch(/^verdict ESCALATE .*example\.co\.jp domain not verified/);
      expect(r.facts.domainsVerified).toBe("0");
    }
    expect(calls).toEqual([]);
  });

  it("crt.sh failing is ESCALATE, never an empty inventory", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const { http } = stubHttp({
      "https://crt.sh/?q=%25.example.co.jp&output=json": { status: 503, body: "busy" },
    });
    const r = await run("guardian_exposure_subdomains", enabled(), home, { http });
    expect(r.verdict).toMatch(
      /^verdict ESCALATE .*certificate transparency unavailable \(HTTP 503\)/,
    );
    expect(readInventory(home)).toBeNull();
  });

  it("HIBP and GitHub are off without config or keys, and escalate", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    expect((await run("guardian_exposure_breaches", enabled(), home)).verdict).toMatch(
      /breach check is off/,
    );
    expect((await run("guardian_exposure_code", enabled(), home)).verdict).toMatch(
      /code search is off/,
    );
    const on = enabled({ hibp: { enabled: true }, github: { enabled: true } });
    expect((await run("guardian_exposure_breaches", on, home)).verdict).toMatch(
      /no HIBP key in the secrets store \(guardian\.exposure\.hibpApiKey\)/,
    );
    expect((await run("guardian_exposure_code", on, home)).verdict).toMatch(
      /no GitHub token in the secrets store \(guardian\.exposure\.githubToken\)/,
    );
  });

  it("HIBP domain search reports counts only; addresses go to a 0600 evidence file", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const { http, calls } = stubHttp({
      "https://haveibeenpwned.com/api/v3/breacheddomain/example.co.jp": {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "taro.yamada": ["Adobe", "LinkedIn"], hanako: ["Adobe"] }),
      },
    });
    const secret = (n: string) =>
      n === "guardian.exposure.hibpApiKey" ? "k-SECRET-hibp-key" : undefined;
    const r = await run("guardian_exposure_breaches", enabled({ hibp: { enabled: true } }), home, {
      http,
      secret,
    });
    expect(calls).toHaveLength(1);
    expect(r.facts.accounts).toBe("2");
    expect(r.text).toMatch(/Adobe 2 account\(s\)/);
    expect(r.text).not.toMatch(/taro|hanako|k-SECRET/);
    const evidence = r.facts.evidence;
    expect(fs.readFileSync(evidence, "utf8")).toContain("taro.yamada");
    if (process.platform !== "win32") {
      expect(fs.statSync(evidence).mode & 0o777).toBe(0o600);
    }
    expect(parseHibpDomain('{"a":["X"],"b":"bad"}').perBreach).toEqual({ X: 1 });
  });

  it("GitHub code search reports file URLs only", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const pages: Record<string, Page> = {};
    const qs = codeQueries(["example.co.jp"], []);
    expect(qs).toHaveLength(4);
    qs.forEach((q, i) => {
      pages[`https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=30`] = {
        body: JSON.stringify({
          items:
            i === 0
              ? [
                  {
                    path: "config/prod.env",
                    html_url: "https://github.com/someone/leak/blob/main/config/prod.env",
                    repository: { full_name: "someone/leak" },
                  },
                ]
              : [],
        }),
      };
    });
    const { http } = stubHttp(pages);
    const r = await run("guardian_exposure_code", enabled({ github: { enabled: true } }), home, {
      http,
      secret: () => "ghp_TESTTOKEN",
    });
    expect(r.facts.files).toBe("1");
    expect(r.verdict).toMatch(/github\.com\/someone\/leak\/blob\/main\/config\/prod\.env/);
    expect(r.text).not.toContain("ghp_TESTTOKEN");
  });
});

// ---- certificate transparency --------------------------------------------------------------------

describe("guardian_exposure_subdomains", () => {
  const ct = (names: string[]) =>
    JSON.stringify(names.map((n, i) => ({ id: i, name_value: n, common_name: n.split("\n")[0] })));

  it("parses crt.sh: wildcards reduced, other domains dropped, sorted, deduplicated", () => {
    const names = parseCrtSh(
      ct([
        "*.Example.co.jp\nexample.co.jp",
        "mail.example.co.jp",
        "evil-example.co.jp",
        "a.b.example.co.jp",
      ]),
      "example.co.jp",
    );
    expect(names).toEqual(["a.b.example.co.jp", "example.co.jp", "mail.example.co.jp"]);
    expect(() => parseCrtSh("<html>busy</html>", "example.co.jp")).toThrow(/not JSON/);
    expect(diffSubdomains(["a"], ["a", "b"])).toEqual(["b"]);
    expect(diffSubdomains(undefined, ["a"])).toEqual(["a"]);
  });

  it("first run is the baseline; later runs report new subdomains", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const url = "https://crt.sh/?q=%25.example.co.jp&output=json";
    const first = await run("guardian_exposure_subdomains", enabled(), home, {
      http: stubHttp({ [url]: { body: ct(["www.example.co.jp", "mail.example.co.jp"]) } }).http,
    });
    expect(first.verdict).toMatch(/^verdict OK/);
    expect(first.facts).toMatchObject({ subdomains: "2", newSubdomains: "0", baseline: "true" });
    const second = await run("guardian_exposure_subdomains", enabled(), home, {
      http: stubHttp({
        [url]: { body: ct(["www.example.co.jp", "mail.example.co.jp", "vpn.example.co.jp"]) },
      }).http,
    });
    expect(second.facts).toMatchObject({ subdomains: "3", newSubdomains: "1", baseline: "false" });
    expect(second.verdict).toMatch(
      /^verdict ESCALATE 1 finding\(s\): vpn\.example\.co\.jp new subdomain/,
    );
    expect(readInventory(home)?.domains["example.co.jp"]).toContain("vpn.example.co.jp");
  });
});

// ---- DNS posture --------------------------------------------------------------------------------

describe("guardian_exposure_dns", () => {
  const good = {
    spf: "v=spf1 include:_spf.google.com -all",
    dmarc: "v=DMARC1; p=reject",
    dmarcPolicy: "reject" as const,
    mx: 1,
    caa: 1,
  };

  it("judges SPF, DMARC and MX", () => {
    expect(judgePosture("e.com", good)).toEqual([]);
    const d = (p: Partial<typeof good> | Record<string, unknown>) =>
      judgePosture("e.com", { ...good, ...p } as never).map((f) => f.detail);
    expect(d({ spf: null })[0]).toMatch(/no SPF/);
    expect(d({ spf: "v=spf1 +all" })[0]).toMatch(/\+all/);
    expect(d({ dmarc: null, dmarcPolicy: null })[0]).toMatch(/no DMARC/);
    expect(d({ dmarc: "v=DMARC1; p=none", dmarcPolicy: "none" })[0]).toMatch(/p=none/);
    expect(d({ mx: 0 })[0]).toMatch(/no MX/);
    expect(dmarcPolicy("v=DMARC1; p=quarantine; rua=mailto:x@e.com")).toBe("quarantine");
    expect(dmarcPolicy("v=DMARC1; sp=reject")).toBeNull();
  });

  it("finds dangling CNAMEs to takeover-prone providers only", async () => {
    expect(takeoverProne("shop.myshopify.com.")).toBe(true);
    expect(takeoverProne("cdn.example.net")).toBe(false);
    const r = stubResolver({
      "CNAME old.example.co.jp": ["oldapp.azurewebsites.net"],
      "CNAME live.example.co.jp": ["live.vercel.app"],
      "A live.vercel.app": ["76.76.21.21"],
      "CNAME cdn.example.co.jp": ["cdn.example.net"],
      "CNAME flaky.example.co.jp": "ETIMEOUT",
    });
    const res = await findDanglingCnames(
      [
        "old.example.co.jp",
        "live.example.co.jp",
        "cdn.example.co.jp",
        "plain.example.co.jp",
        "flaky.example.co.jp",
      ],
      r,
    );
    expect(res.dangling).toEqual([
      { host: "old.example.co.jp", target: "oldapp.azurewebsites.net" },
    ]);
    expect(res.errors).toBe(1);
  });

  it("is OK only for a clean posture; a failed lookup escalates", async () => {
    const r = stubResolver({
      "TXT example.co.jp": [["v=spf1 -all"]],
      "TXT _dmarc.example.co.jp": [["v=DMARC1; p=reject"]],
      "MX example.co.jp": [{ exchange: "mx.example.co.jp", priority: 10 }],
      "CAA example.co.jp": [],
    });
    const clean = await checkDnsPosture(["example.co.jp"], {}, r);
    expect(clean.findings).toEqual([]);
    expect(clean.facts.withCaa).toBe(0);
    const broken = await checkDnsPosture(
      ["example.co.jp"],
      {},
      stubResolver({ "TXT example.co.jp": "ESERVFAIL" }),
    );
    expect(broken.findings[0].detail).toMatch(/DNS lookup failed \(ESERVFAIL\)/);
  });

  it("through the engine: takeover findings come first", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const url = "https://crt.sh/?q=%25.example.co.jp&output=json";
    await run("guardian_exposure_subdomains", enabled(), home, {
      http: stubHttp({ [url]: { body: JSON.stringify([{ name_value: "old.example.co.jp" }]) } })
        .http,
    });
    const resolver = stubResolver({
      "TXT example.co.jp": [["v=spf1 -all"]],
      "TXT _dmarc.example.co.jp": [["v=DMARC1; p=none"]],
      "MX example.co.jp": [{ exchange: "mx.example.co.jp", priority: 10 }],
      "CNAME old.example.co.jp": ["oldapp.azurewebsites.net"],
    });
    const r = await run("guardian_exposure_dns", enabled(), home, { resolver });
    expect(r.facts.finding1).toMatch(/^old\.example\.co\.jp possible subdomain takeover/);
    expect(r.facts.finding2).toMatch(/p=none/);
    expect(r.verdict).toMatch(/^verdict ESCALATE 2 finding/);
  });
});

// ---- crawler and detection ----------------------------------------------------------------------

describe("guardian_exposure_web_secrets", () => {
  it("parses robots.txt: own group over *, longest match, Allow on tie", () => {
    const allow = parseRobots(
      "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /",
    );
    expect(allow("/")).toBe(true);
    expect(allow("/private/x")).toBe(false);
    expect(allow("/private/ok/y")).toBe(true);
    const mine = parseRobots(
      "User-agent: *\nDisallow:\n\nUser-agent: Kurahi-Guardian-Exposure\nDisallow: /",
    );
    expect(mine("/anything")).toBe(false);
    expect(parseRobots("User-agent: *\nDisallow: /*.json$")("/a/b.json")).toBe(false);
  });

  it("detects keys and plaintext credentials (EN/PT/JA) and never returns a value", () => {
    const page = [
      "<html><body>",
      "<h2>Portal do convênio</h2>",
      "<p>Usuário: hospital01 Senha: Conv2024!x</p>",
      "<table><tr><th>ログインID</th><td>kanja-portal</td></tr><tr><th>パスワード</th><td>Hosp#5521</td></tr></table>",
      "<p>Password: required</p><p>パスワード：********</p><p>パスワードを入力してください</p>",
      "<script>const key = 'AIzaSyD-THIS-IS-A-TEST-KEY-123456789';</script>",
      '<input type="password" name="pw" value="Prefill99!">',
      "</body></html>",
    ].join("\n");
    const hits = detectSecrets(page, "text/html; charset=utf-8");
    const values = [
      "Conv2024!x",
      "Hosp#5521",
      "AIzaSyD-THIS-IS-A-TEST-KEY-123456789",
      "Prefill99!",
    ];
    expect(hits.map((h) => h.detector).toSorted()).toEqual(
      [
        "google-api-key",
        "password-input-value",
        "plaintext-login-password",
        "plaintext-login-password",
      ].toSorted(),
    );
    const out = JSON.stringify(hits);
    for (const v of values) {
      expect(out).not.toContain(v);
    }
    const pt = hits.find((h) => h.sha256 === sha256Hex("Conv2024!x"))!;
    expect(pt).toMatchObject({ preview: "Co…!x", line: 3 });
    expect(hits.find((h) => h.sha256 === sha256Hex("Hosp#5521"))?.preview).toBe("Ho…21");
    expect(plausibleCredential("********")).toBe(false);
    expect(plausibleCredential("required")).toBe(false);
    expect(plausibleCredential("入力してください")).toBe(false);
  });

  it("does not mistake minified JavaScript for a key = value secret", () => {
    const js =
      'var a={API_KEY:c,return e},b={PASSWORD:e.password,TOKEN:t.token.value,SECRET:"Unauthorized",KEY:"/_next/notfound"};const SECRET_KEY="s3cr3t-Value-99";';
    const hits = detectSecrets(js, "application/javascript");
    expect(hits.map((h) => h.detector)).toEqual(["env-assignment"]);
    expect(hits[0].sha256).toBe(sha256Hex("s3cr3t-Value-99"));
  });

  it("extracts same-origin links only", () => {
    const links = extractLinks(
      '<a href="/about">a</a><a href="https://other.example.net/x">b</a><script src="/app.js"></script><a href="/logo.png">c</a><a href="mailto:x@e.com">m</a>',
      "https://example.co.jp/",
    );
    expect(links).toEqual(["https://example.co.jp/about", "https://example.co.jp/app.js"]);
  });

  it("stays in scope, respects robots.txt and limits, and follows redirects only within scope", async () => {
    const html = (body: string) => ({ headers: { "content-type": "text/html" }, body });
    const { http, calls } = stubHttp({
      "https://example.co.jp/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /admin",
      },
      "https://example.co.jp/": html(
        '<a href="/a">a</a><a href="/admin/secret">x</a><a href="https://evil.example.net/">e</a><a href="/go">g</a><a href="/img">i</a>',
      ),
      "https://example.co.jp/a": html('<a href="/b">b</a><p>Senha: Abc123456!</p>'),
      "https://example.co.jp/b": html('<a href="/c">c</a>'),
      "https://example.co.jp/c": html("deep"),
      "https://example.co.jp/go": {
        status: 302,
        headers: { location: "https://evil.example.net/login" },
      },
      "https://example.co.jp/img": { headers: { "content-type": "image/png" }, body: "PNG" },
      "https://www.example.co.jp/robots.txt": new Error("getaddrinfo ENOTFOUND www.example.co.jp"),
    });
    const r = await crawlSites({
      hosts: ["example.co.jp", "www.example.co.jp"],
      http,
      sleep: noSleep,
      limits: { maxPages: 50, maxBytes: 1_000_000, maxDepth: 2 },
    });
    expect(calls.some((u) => u.includes("evil.example.net"))).toBe(false);
    expect(calls).not.toContain("https://example.co.jp/admin/secret");
    expect(calls).not.toContain("https://example.co.jp/c"); // depth 3 > maxDepth 2
    expect(r.robotsBlocked).toBe(1);
    expect(r.skippedType).toBe(1);
    expect(r.sitesUnreachable).toBe(1);
    expect(r.secrets).toHaveLength(1);
    expect(r.secrets[0].url).toBe("https://example.co.jp/a");
    expect(r.truncatedBy).toBeNull();

    const limited = await crawlSites({
      hosts: ["example.co.jp"],
      http,
      sleep: noSleep,
      limits: { maxPages: 1, maxBytes: 1_000_000, maxDepth: 3 },
    });
    expect(limited.pages).toBe(1);
    expect(limited.truncatedBy).toBe("maxPages");
  });

  it("an unreadable robots.txt means the site is not crawled, and that escalates", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const { http, calls } = stubHttp({
      "https://example.co.jp/robots.txt": { status: 503 },
      "https://www.example.co.jp/robots.txt": new Error("getaddrinfo ENOTFOUND www.example.co.jp"),
    });
    const r = await run("guardian_exposure_web_secrets", enabled(), home, { http });
    expect(calls).not.toContain("https://example.co.jp/");
    expect(r.verdict).toMatch(/^verdict ESCALATE .*robots\.txt unavailable; site not crawled/);
  });

  it("through the engine: masked findings, never the value", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const { http } = stubHttp({
      "https://example.co.jp/robots.txt": { status: 404 },
      "https://example.co.jp/": {
        headers: { "content-type": "text/html" },
        body: "<p>Login: clinic-07</p>\n<p>Password: Qx7!pass-2026</p>",
      },
      "https://www.example.co.jp/robots.txt": new Error("getaddrinfo ENOTFOUND www.example.co.jp"),
    });
    const r = await run("guardian_exposure_web_secrets", enabled(), home, { http });
    expect(r.verdict).toMatch(/^verdict ESCALATE 1 finding/);
    expect(r.facts.finding1).toBe(
      `https://example.co.jp/:2 possible plaintext-login-password preview=Qx…26 sha256=${sha256Hex("Qx7!pass-2026")}`,
    );
    expect(r.text).not.toContain("Qx7!pass-2026");
  });
});

// ---- lookalikes ---------------------------------------------------------------------------------

describe("guardian_exposure_lookalikes", () => {
  it("generates bounded, valid permutations without the domain itself", () => {
    expect(splitDomain("example.co.jp")).toEqual({ name: "example", suffix: "co.jp" });
    expect(splitDomain("kodasoken.com")).toEqual({ name: "kodasoken", suffix: "com" });
    const all = lookalikeDomains("kodasoken.com", 300);
    expect(all.length).toBeLessThanOrEqual(300);
    expect(all.length).toBeGreaterThan(80);
    expect(all).not.toContain("kodasoken.com");
    expect(all.every(isValidDomain)).toBe(true);
    for (const d of [
      "kodasoken.net",
      "kodasoken.co.jp",
      "k0dasoken.com",
      "kodas0ken.com",
      "koda-soken.com",
      "kodasken.com",
    ]) {
      expect(all).toContain(d);
    }
    expect(lookalikeDomains("kodasoken.com", 10)).toHaveLength(10);
  });

  it("reports registered lookalikes with MX first; failed lookups escalate", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const resolver = stubResolver({
      "NS example.com": ["ns1.parking.example"],
      "A example.com": ["192.0.2.1"],
      "NS examp1e.co.jp": ["ns1.bad.example"],
      "MX examp1e.co.jp": [{ exchange: "mail.bad.example", priority: 10 }],
      "NS example.net": "ESERVFAIL",
    });
    const r = await run(
      "guardian_exposure_lookalikes",
      enabled({ lookalikes: { max: 50 } }),
      home,
      { resolver },
    );
    expect(Number(r.facts.candidates)).toBeLessThanOrEqual(50);
    expect(r.facts).toMatchObject({ registered: "2", withMx: "1", lookupErrors: "1" });
    expect(r.facts.finding1).toMatch(/^examp1e\.co\.jp registered lookalike WITH MX/);
    expect(r.verdict).toMatch(/^verdict ESCALATE/);
    const ignored = await run(
      "guardian_exposure_lookalikes",
      enabled({ lookalikes: { max: 50, ignore: ["example.com", "examp1e.co.jp", "example.net"] } }),
      home,
      { resolver },
    );
    expect(ignored.verdict).toMatch(/^verdict OK no registered lookalike/);
  });
});
