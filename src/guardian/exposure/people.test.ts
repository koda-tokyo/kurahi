import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GuardianConfig } from "../../config/types.guardian.js";
import { runEngineToolAsync } from "../../autopilot/engine-tools.js";
import { type ExposureDeps, type HttpGet, recordAttestation } from "./common.js";
import {
  CONSENT_TEXT_VERSION,
  confirmConsent,
  enrolPerson,
  getEnrolment,
  handleVariants,
  listEnrolments,
  peopleFile,
  purgeExpired,
  redactedEnrolment,
  resultsForPrincipal,
  revokeConsent,
} from "./people.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-people-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const newHome = () => {
  const h = path.join(root, `h${++n}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
};

const EMAIL = "taro.yamada@example.co.jp";
const PHONE = "+81 90-1234-5678";
const T0 = new Date("2026-10-31T00:00:00Z");

function http(pages: Record<string, { status?: number; body?: string; type?: string }>) {
  const calls: string[] = [];
  const get: HttpGet = async (url) => {
    calls.push(url);
    const p = pages[url];
    return {
      status: p ? (p.status ?? 200) : 404,
      headers: { "content-type": p?.type ?? "text/html" },
      body: p?.body ?? "",
      truncated: false,
    };
  };
  return { get, calls };
}

const cfg = (people: Record<string, unknown> = {}): GuardianConfig => ({
  exposure: {
    enabled: true,
    domains: ["example.co.jp"],
    people: { enabled: true, platforms: ["github", "qiita"], ...people },
  },
});

async function run(home: string, guardian: GuardianConfig, over: Partial<ExposureDeps> = {}) {
  const deps: Partial<ExposureDeps> = {
    resolver: {
      resolveTxt: async () => [],
      resolveMx: async () => [],
      resolveCaa: async () => [],
      resolveCname: async () => [],
      resolveNs: async () => [],
      resolve4: async () => [],
      resolve6: async () => [],
    },
    http: http({}).get,
    sleep: async () => undefined,
    secret: () => undefined,
    now: () => T0,
    ...over,
  };
  const text = await runEngineToolAsync(
    "guardian_exposure_people",
    {},
    {
      projectId: "ppeople",
      home,
      guardian,
      exposure: deps,
    },
  );
  return { text, verdict: text.slice(text.lastIndexOf("\n") + 1) };
}

async function enrolAndConfirm(
  home: string,
  identifiers = [
    { kind: "email" as const, value: EMAIL },
    { kind: "handle" as const, value: "@TaroY" },
    { kind: "phone" as const, value: PHONE },
  ],
) {
  const { enrolment, relayCodes } = await enrolPerson({
    home,
    enrolledBy: "admin:security-lead",
    selfEnrolled: false,
    principal: "device:taro0000001",
    identifiers,
    now: T0,
  });
  confirmConsent({
    home,
    id: enrolment.id,
    code: relayCodes[0].code,
    by: "device:taro0000001",
    textVersion: CONSENT_TEXT_VERSION,
    now: T0,
  });
  return enrolment.id;
}

describe("personal exposure: consent", () => {
  it("nobody enrolled → ESCALATE no consent, and nothing is fetched", async () => {
    const home = newHome();
    const h = http({});
    const r = await run(home, cfg(), { http: h.get });
    expect(r.verdict).toMatch(/no consent: nobody has enrolled and confirmed/);
    expect(h.calls).toEqual([]);
  });

  it("is off unless people.enabled", async () => {
    const r = await run(newHome(), cfg({ enabled: false }));
    expect(r.verdict).toMatch(/^verdict ESCALATE .*personal exposure is not enabled/);
  });

  it("an enrolment the person has not confirmed runs no check", async () => {
    const home = newHome();
    await enrolPerson({
      home,
      enrolledBy: "admin:security-lead",
      selfEnrolled: false,
      identifiers: [
        { kind: "email", value: EMAIL },
        { kind: "handle", value: "taroy" },
      ],
      now: T0,
    });
    const h = http({});
    const r = await run(home, cfg(), { http: h.get });
    expect(r.verdict).toMatch(/no consent/);
    expect(r.text).toMatch(/fact pending=1/);
    expect(h.calls).toEqual([]);
  });

  it("needs an email, the right code and the current consent text", async () => {
    const home = newHome();
    await expect(
      enrolPerson({
        home,
        enrolledBy: "admin:x",
        selfEnrolled: false,
        identifiers: [{ kind: "handle", value: "taroy" }],
      }),
    ).rejects.toThrow(/email address/);
    const { enrolment, relayCodes } = await enrolPerson({
      home,
      enrolledBy: "admin:x",
      selfEnrolled: false,
      identifiers: [{ kind: "email", value: EMAIL }],
      now: T0,
    });
    expect(relayCodes).toHaveLength(1);
    const confirm = (code: string, textVersion = CONSENT_TEXT_VERSION) =>
      confirmConsent({ home, id: enrolment.id, code, by: "device:taro", textVersion, now: T0 });
    expect(() => confirm(relayCodes[0].code, "old")).toThrow(/consent text version/);
    expect(() => confirm("00000000")).toThrow(/wrong code/);
    const ok = confirm(relayCodes[0].code);
    expect(ok.consent.state).toBe("given");
    expect(ok.identifiers[0]).toMatchObject({ verified: true, method: "relayed-email-code" });
    // The code is stored only as a salted hash and is gone after use.
    expect(fs.readFileSync(peopleFile(home), "utf8")).not.toContain(relayCodes[0].code);
  });

  it("a sender delivers the code to the address itself; no code is shown to the admin", async () => {
    const home = newHome();
    const sent: string[] = [];
    const r = await enrolPerson({
      home,
      enrolledBy: "self:device:taro",
      selfEnrolled: true,
      identifiers: [{ kind: "email", value: EMAIL }],
      sender: async (to) => {
        sent.push(to);
      },
    });
    expect(sent).toEqual([EMAIL]);
    expect(r.relayCodes).toEqual([]);
  });

  it("phone stays unverified and is never checked; handles count under the verified email", async () => {
    const home = newHome();
    const id = await enrolAndConfirm(home);
    const e = getEnrolment(home, id)!;
    expect(e.identifiers.map((i) => [i.kind, i.verified, i.method])).toEqual([
      ["email", true, "relayed-email-code"],
      ["handle", true, "declared-under-verified-email"],
      ["phone", false, "attested-unverified"],
    ]);
    const shown = JSON.stringify(redactedEnrolment(e));
    expect(shown).not.toContain(EMAIL);
    expect(shown).not.toContain("1234-5678");
  });
});

describe("personal exposure: checks", () => {
  it("runs consented checks; facts carry counts and platforms, never the email or phone", async () => {
    const home = newHome();
    recordAttestation(home, "example.co.jp", "admin:test");
    const id = await enrolAndConfirm(home);
    const h = http({
      "https://github.com/taroy": {},
      "https://qiita.com/taroy": { status: 404 },
      "https://github.com/taroy-official": {},
      "https://example.co.jp/robots.txt": { status: 404 },
      "https://example.co.jp/": { body: `<a href="/staff">s</a>` },
      "https://example.co.jp/staff": { body: `<p>Contact ${EMAIL} or 090-1234-5678</p>` },
      "https://haveibeenpwned.com/api/v3/breachedaccount/taro.yamada%40example.co.jp?truncateResponse=true":
        {
          body: JSON.stringify([{ Name: "Adobe" }]),
          type: "application/json",
        },
    });
    const r = await run(home, cfg({ hibp: { enabled: true } }), {
      http: h.get,
      secret: (name) => (name === "guardian.exposure.hibpApiKey" ? "hibp-test-key" : undefined),
    });
    expect(r.verdict).toMatch(/^verdict ESCALATE/);
    expect(r.text).toContain(`fact ${id}=`);
    expect(r.text).toMatch(/handlesOn=GitHub/);
    expect(r.text).toMatch(/i1 \(email\) in 1 breach\(es\): Adobe/);
    expect(r.text).toMatch(/possible impersonation: a variant \(ta…al\) of i2 exists on GitHub/);
    expect(r.text).toMatch(
      /i1 \(email\) published on 1 page\(s\).*https:\/\/example\.co\.jp\/staff/,
    );
    for (const secret of [EMAIL, "taro.yamada", "1234-5678", "12345678", "hibp-test-key"]) {
      expect(r.text).not.toContain(secret);
    }
    // The unverified phone was not searched on the sites.
    expect(r.text).not.toMatch(/\(phone\) published/);
    // Only the curated platforms, the HIBP API and the organisation's own site were contacted.
    expect(
      h.calls.every((u) =>
        /^https:\/\/(github\.com|qiita\.com|haveibeenpwned\.com|example\.co\.jp|www\.example\.co\.jp)\//.test(
          u,
        ),
      ),
    ).toBe(true);
    // Results are kept for the person (by principal) and the security role.
    const mine = resultsForPrincipal(home, "device:taro0000001");
    expect(mine[0].id).toBe(id);
    expect(mine[0].results?.findings.length).toBeGreaterThan(0);
    expect(resultsForPrincipal(home, "device:someone")).toEqual([]);
  });

  it("only the consented checks run", async () => {
    const home = newHome();
    const { enrolment, relayCodes } = await enrolPerson({
      home,
      enrolledBy: "admin:x",
      selfEnrolled: false,
      identifiers: [
        { kind: "email", value: EMAIL },
        { kind: "handle", value: "taroy" },
      ],
      checks: ["handles"],
      now: T0,
    });
    confirmConsent({
      home,
      id: enrolment.id,
      code: relayCodes[0].code,
      by: "p",
      textVersion: CONSENT_TEXT_VERSION,
      now: T0,
    });
    const h = http({ "https://github.com/taroy": {} });
    await run(home, cfg(), { http: h.get });
    expect(h.calls.toSorted()).toEqual(["https://github.com/taroy", "https://qiita.com/taroy"]);
  });

  it("variants are bounded and differ from the handle", () => {
    const v = handleVariants("taroy");
    expect(v.length).toBeLessThanOrEqual(6);
    expect(v).not.toContain("taroy");
    expect(v).toContain("tar0y");
  });
});

describe("personal exposure: revocation", () => {
  it("revocation stops checks at once and purges everything after the retention period", async () => {
    const home = newHome();
    const id = await enrolAndConfirm(home);
    revokeConsent({ home, id, by: "device:taro0000001", retentionDays: 30, now: T0 });
    const h = http({ "https://github.com/taroy": {} });
    const r = await run(home, cfg(), { http: h.get });
    expect(r.verdict).toMatch(/no consent/);
    expect(h.calls).toEqual([]);
    expect(getEnrolment(home, id)?.consent.state).toBe("revoked");
    expect(purgeExpired(home, 30, new Date(T0.getTime() + 29 * 86_400_000))).toEqual([]);
    expect(purgeExpired(home, 30, new Date(T0.getTime() + 30 * 86_400_000))).toEqual([id]);
    expect(listEnrolments(home)).toEqual([]);
    expect(fs.readFileSync(peopleFile(home), "utf8")).not.toContain("taro");
  });

  it("the check run itself purges expired records", async () => {
    const home = newHome();
    const id = await enrolAndConfirm(home);
    revokeConsent({ home, id, by: "admin:x", retentionDays: 0, now: T0 });
    const r = await run(home, cfg({ retentionDays: 0 }));
    expect(r.text).toMatch(/fact purged=1/);
    expect(getEnrolment(home, id)).toBeNull();
  });

  it("the people file is owner-only", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = newHome();
    await enrolAndConfirm(home);
    expect(fs.statSync(peopleFile(home)).mode & 0o777).toBe(0o600);
  });
});
