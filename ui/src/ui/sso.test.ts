import { describe, expect, it } from "vitest";
import {
  describeSsoError,
  exchangeSsoCode,
  fetchSsoConfig,
  readSsoFragment,
  ssoLoginHref,
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
