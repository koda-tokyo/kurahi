import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { renderOverview, type OverviewProps } from "./overview";

afterEach(() => setLocale("en"));

function props(patch: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: false,
    hello: null,
    health: null,
    settings: { gatewayUrl: "", token: "", sessionKey: "main" } as never,
    password: "",
    lastError: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    onSettingsChange: () => {},
    onPasswordChange: () => {},
    onSessionKeyChange: () => {},
    onConnect: () => {},
    onRefresh: () => {},
    sso: { enabled: true, required: false, providers: [], passkeys: { enabled: true, totp: true } },
    passkey: { enrollCode: undefined, busy: false, notice: null, totpSetup: null },
    ...patch,
  };
}

function mount(p: OverviewProps): HTMLElement {
  const el = document.createElement("div");
  // Forms submit only while connected to the document.
  document.body.replaceChildren(el);
  render(renderOverview(p), el);
  return el;
}

describe("overview: built-in sign-in", () => {
  it("offers a passkey button and a one-time code form", () => {
    let passkey = 0;
    let totp: string[] = [];
    const el = mount(
      props({
        onPasskeySignIn: () => (passkey += 1),
        onTotpSignIn: (u, c) => (totp = [u, c]),
      }),
    );
    const login = el.querySelector('[data-testid="passkey-login"]')!;
    const button = login.querySelector("button")!;
    expect(button.textContent?.trim()).toBe("Sign in with a passkey");
    button.click();
    expect(passkey).toBe(1);
    const form = login.querySelector("form")!;
    (form.querySelector('[name="userName"]') as HTMLInputElement).value = "aiko@example.com";
    (form.querySelector('[name="code"]') as HTMLInputElement).value = "123456";
    form.requestSubmit();
    expect(totp).toEqual(["aiko@example.com", "123456"]);
  });

  it("shows the enrollment panel in Japanese for an enrollment link", () => {
    setLocale("ja");
    let label: string | null = null;
    const el = mount(
      props({
        passkey: { enrollCode: "kpe_x", busy: false, notice: null, totpSetup: null },
        onPasskeyEnroll: (l) => (label = l),
      }),
    );
    const panel = el.querySelector('[data-testid="passkey-enroll"]')!;
    expect(panel.textContent).toContain("パスキーを作成");
    expect(panel.textContent).toContain("認証アプリを使う");
    expect(el.querySelector('[data-testid="passkey-login"]')).toBeNull();
    panel.querySelector("form")!.requestSubmit();
    expect(label).toBe("");
  });

  it("hides passkeys when the gateway has them off", () => {
    const el = mount(props({ sso: { enabled: false, required: false, providers: [] } }));
    expect(el.querySelector('[data-testid="passkey-login"]')).toBeNull();
  });
});
