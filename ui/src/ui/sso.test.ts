import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import {
  creationOptionsFromJson,
  credentialToJson,
  describePasskeyError,
  passkeySignIn,
  passkeyStepUp,
  readEnrollFragment,
  requestOptionsFromJson,
  totpSignIn,
  describeSsoError,
  exchangeSsoCode,
  fetchSsoConfig,
  readSsoFragment,
  readStepUpFragment,
  runStepUp,
  ssoLoginHref,
  stepUpRequired,
  ssoLogout,
} from "./sso";

describe("organisation sign-in fragment", () => {
  it("reads the one-time code and keeps other fragment parameters", () => {
    const code = "c".repeat(43);
    expect(readSsoFragment(`#sso_code=${code}&tab=chat`)).toEqual({
      code,
      error: null,
      rest: "#tab=chat",
    });
    expect(readSsoFragment("#sso_error=no_role")).toEqual({
      code: null,
      error: "no_role",
      rest: "",
    });
    expect(readSsoFragment("#tab=chat")).toBeNull();
    expect(readSsoFragment("#sso_code=x")).toMatchObject({ code: null, error: "malformed" });
    // The old token-in-fragment form is not read any more.
    expect(readSsoFragment(`#sso=kss_${"a".repeat(43)}`)).toBeNull();
  });

  it("exchanges the code once by POST, with the cookie, for the session token", async () => {
    const token = `kss_${"a".repeat(43)}`;
    let seen: RequestInit | undefined;
    let url = "";
    const ok = await exchangeSsoCode("https://g", "code-1", async (u, init) => {
      url = u;
      seen = init;
      return new Response(JSON.stringify({ token }));
    });
    expect(ok).toEqual({ token });
    expect(url).toBe("https://g/api/identity/sso/exchange");
    expect(seen?.method).toBe("POST");
    expect(seen?.credentials).toBe("same-origin");
    expect(JSON.parse(seen?.body as string)).toEqual({ code: "code-1" });
    const refused = await exchangeSsoCode(
      "https://g",
      "code-1",
      async () =>
        new Response(JSON.stringify({ error: { type: "code_unknown" } }), { status: 400 }),
    );
    expect(refused).toEqual({ error: "code_unknown" });
    expect(describeSsoError("code_expired")).toContain("expired");
  });

  it("builds the login link back to this page and describes refusals", () => {
    const href = ssoLoginHref(
      "https://gateway.example.test",
      { id: "corp", kind: "oidc", label: "Company", loginPath: "/api/identity/sso/corp/login" },
      "/console?x=1",
    );
    expect(href).toBe(
      "https://gateway.example.test/api/identity/sso/corp/login?returnTo=%2Fconsole%3Fx%3D1",
    );
    expect(describeSsoError("no_role")).toContain("no role");
  });

  it("reads the provider list and logs out with the bearer token", async () => {
    const config = await fetchSsoConfig(
      "https://g",
      async () => new Response(JSON.stringify({ enabled: true, required: false, providers: [] })),
    );
    expect(config).toEqual({ enabled: true, required: false, providers: [] });
    let auth = "";
    const url = await ssoLogout("https://g", "kss_x", async (_u, init) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(
        JSON.stringify({ ok: true, endSessionUrl: "https://idp.example/logout?x" }),
      );
    });
    expect(auth).toBe("Bearer kss_x");
    expect(url).toBe("https://idp.example/logout?x");
  });
});

describe("step-up (confirm it's you)", () => {
  const okFetch = (url = "https://idp.example/authorize?max_age=0") =>
    (async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, url, provider: "corp" }), { status: 200 });
    }) as unknown as typeof fetch;
  let calls: Array<{ input: string; init?: RequestInit }> = [];
  const popup = (hashes: string[]) => {
    const p = {
      closed: false,
      location: { href: "", hash: "" },
      close: () => {
        p.closed = true;
      },
    };
    let i = 0;
    Object.defineProperty(p.location, "hash", {
      get: () => {
        const h = hashes[Math.min(i, hashes.length - 1)];
        i += 1;
        if (h === "cross-origin") {
          throw new Error("SecurityError");
        }
        return h;
      },
    });
    return p;
  };

  it("recognises the gateway's structured refusal only", () => {
    expect(
      stepUpRequired({
        details: {
          code: "step_up_required",
          why: "method",
          maxAgeSeconds: 120,
          requireMethods: ["hwk"],
          stepUpPath: "https://evil.example/x",
        },
      }),
    ).toEqual({
      why: "method",
      maxAgeSeconds: 120,
      requireMethods: ["hwk"],
      stepUpPath: "/api/identity/sso/step-up",
    });
    expect(stepUpRequired({ details: { code: "checks_failed" } })).toBeNull();
    expect(stepUpRequired(new Error("x"))).toBeNull();
  });

  it("reads the outcome fragment", () => {
    expect(readStepUpFragment("#sso_stepup=ok")).toBe("ok");
    expect(readStepUpFragment("#sso_error=person_mismatch")).toBe("person_mismatch");
    expect(readStepUpFragment("#tab=x")).toBeNull();
  });

  it("opens the IdP in the popup with the session token and waits for the console to return", async () => {
    calls = [];
    const p = popup(["cross-origin", "cross-origin", "sso_stepup=ok"]);
    const out = await runStepUp({
      origin: "https://gw.example",
      token: "kss_token",
      returnTo: "/business",
      fetchImpl: okFetch(),
      open: () => p,
      pollMs: 1,
    });
    expect(out).toEqual({ ok: true });
    expect(p.location.href).toBe("https://idp.example/authorize?max_age=0");
    expect(p.closed).toBe(true);
    expect(calls[0].input).toBe("https://gw.example/api/identity/sso/step-up");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer kss_token" });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ returnTo: "/business" });
  });

  it("reports a refusal, a closed popup, and falls back to the same window", async () => {
    const refused = await runStepUp({
      origin: "https://gw.example",
      token: "t",
      returnTo: "/",
      fetchImpl: okFetch(),
      open: () => popup(["sso_error=person_mismatch"]),
      pollMs: 1,
    });
    expect(refused).toEqual({ ok: false, reason: "person_mismatch" });
    const p = popup(["cross-origin"]);
    p.closed = true;
    expect(
      await runStepUp({
        origin: "https://gw.example",
        token: "t",
        returnTo: "/",
        fetchImpl: okFetch(),
        open: () => p,
        pollMs: 1,
      }),
    ).toEqual({ ok: false, reason: "closed" });
    let navigated = "";
    expect(
      await runStepUp({
        origin: "https://gw.example",
        token: "t",
        returnTo: "/",
        fetchImpl: okFetch(),
        open: () => null,
        navigate: (u) => {
          navigated = u;
        },
      }),
    ).toEqual({ ok: false, reason: "redirected" });
    expect(navigated).toContain("https://idp.example/");
    const bad = await runStepUp({
      origin: "https://gw.example",
      token: "t",
      returnTo: "/",
      fetchImpl: okFetch("javascript:alert(1)"),
      open: () => popup([""]),
    });
    expect(bad).toEqual({ ok: false, reason: "step_up_failed" });
  });
});

describe("built-in sign-in (passkeys, one-time codes)", () => {
  const token = `kss_${"b".repeat(43)}`;
  const enc = (bytes: number[]) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  it("reads and validates the enrollment fragment", () => {
    const code = `kpe_${"x".repeat(32)}`;
    expect(readEnrollFragment(`#kurahi_enroll=${code}&tab=chat`)).toEqual({
      code,
      rest: "#tab=chat",
    });
    expect(readEnrollFragment("#kurahi_enroll=nope")).toEqual({ code: null, rest: "" });
    expect(readEnrollFragment("#tab=chat")).toBeNull();
  });

  it("turns base64url options into WebAuthn buffers", () => {
    const create = creationOptionsFromJson({
      challenge: enc([1, 2, 3]),
      rp: { id: "g", name: "Kurahi" },
      user: { id: enc([9, 9]), name: "a", displayName: "A" },
      excludeCredentials: [{ type: "public-key", id: enc([7]) }],
    });
    expect([...new Uint8Array(create.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(create.user.id as ArrayBuffer)]).toEqual([9, 9]);
    expect([...new Uint8Array(create.excludeCredentials![0].id as ArrayBuffer)]).toEqual([7]);
    const get = requestOptionsFromJson({ challenge: enc([255, 254]), rpId: "g" });
    expect([...new Uint8Array(get.challenge as ArrayBuffer)]).toEqual([255, 254]);
    expect(get.allowCredentials).toEqual([]);
  });

  it("serialises a credential without toJSON()", () => {
    const buf = (b: number[]) => Uint8Array.from(b).buffer;
    const json = credentialToJson({
      rawId: buf([1, 2]),
      type: "public-key",
      response: {
        clientDataJSON: buf([3]),
        authenticatorData: buf([4]),
        signature: buf([5]),
        userHandle: buf([6]),
      },
    } as unknown as PublicKeyCredential);
    expect(json).toEqual({
      id: enc([1, 2]),
      rawId: enc([1, 2]),
      type: "public-key",
      response: {
        clientDataJSON: enc([3]),
        authenticatorData: enc([4]),
        signature: enc([5]),
        userHandle: enc([6]),
      },
    });
  });

  it("steps the session up with a passkey (Bearer on both calls; the token stays)", async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: ((init?.headers ?? {}) as Record<string, string>).Authorization });
      if (url.endsWith("/stepup/begin")) {
        return new Response(
          JSON.stringify({ ceremonyId: "c1", publicKey: { challenge: enc([1]), rpId: "g" } }),
        );
      }
      return new Response(JSON.stringify({ ok: true, auth: { methods: ["hwk"] } }));
    };
    const credentials = {
      get: async () => ({ toJSON: () => ({ id: "cred" }) }),
      create: async () => null,
    } as unknown as CredentialsContainer;
    expect(await passkeyStepUp("https://g", "kss_t", { fetch: fetchImpl, credentials })).toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      { url: "https://g/api/identity/passkey/stepup/begin", auth: "Bearer kss_t" },
      { url: "https://g/api/identity/passkey/stepup/finish", auth: "Bearer kss_t" },
    ]);
  });

  it("signs in with a passkey: begin, browser ceremony, finish → token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      if (url.endsWith("/login/begin")) {
        return new Response(
          JSON.stringify({ ceremonyId: "c1", publicKey: { challenge: enc([1]), rpId: "g" } }),
        );
      }
      return new Response(JSON.stringify({ token, methods: ["hwk", "user"] }));
    };
    const credentials = {
      get: async () => ({ toJSON: () => ({ id: "cred" }) }),
      create: async () => null,
    } as unknown as CredentialsContainer;
    expect(await passkeySignIn("https://g", { fetch: fetchImpl, credentials })).toEqual({ token });
    expect(calls.map((c) => c.url)).toEqual([
      "https://g/api/identity/passkey/login/begin",
      "https://g/api/identity/passkey/login/finish",
    ]);
    expect(calls[1].body).toEqual({ ceremonyId: "c1", credential: { id: "cred" } });

    // The person cancels the browser prompt: no finish request.
    const cancelled = {
      get: async () => {
        throw Object.assign(new Error("no"), { name: "NotAllowedError" });
      },
    } as unknown as CredentialsContainer;
    calls.length = 0;
    expect(await passkeySignIn("https://g", { fetch: fetchImpl, credentials: cancelled })).toEqual({
      error: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });

  it("one-time code sign-in passes refusals through", async () => {
    const refuse = async () =>
      new Response(JSON.stringify({ error: { type: "code_refused" } }), { status: 400 });
    expect(await totpSignIn("https://g", "aiko", "123 456", refuse)).toEqual({
      error: "code_refused",
    });
    let body: unknown;
    const ok = async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token }));
    };
    expect(await totpSignIn("https://g", " aiko ", "123 456", ok)).toEqual({ token });
    expect(body).toEqual({ userName: "aiko", code: "123456" });
  });

  it("describes refusals in the console language", () => {
    expect(describePasskeyError("code_refused")).toMatch(/did not work/);
    setLocale("ja");
    try {
      expect(describePasskeyError("code_refused")).toBe(
        "コードが正しくありません。次のコードが表示されてから再度お試しください。",
      );
      expect(describePasskeyError("weird")).toBe("サインインが拒否されました（weird）。");
    } finally {
      setLocale("en");
    }
  });
});
