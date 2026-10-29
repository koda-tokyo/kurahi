import { afterEach, describe, expect, it } from "vitest";
import { isInviteToken, readInviteCode, takeInviteFragment } from "./demo-invite-link";

const CODE = "kdi_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz";

describe("readInviteCode", () => {
  it("reads the code and keeps other fragment parameters", () => {
    expect(readInviteCode(`#invite=${CODE}`)).toEqual({ code: CODE, rest: "" });
    expect(readInviteCode(`#a=1&invite=${CODE}&b=2`)).toEqual({ code: CODE, rest: "#a=1&b=2" });
  });

  it("ignores a fragment without an invite", () => {
    expect(readInviteCode("")).toBeNull();
    expect(readInviteCode("#")).toBeNull();
    expect(readInviteCode("#pair=kpi_abcdefgh12")).toBeNull();
  });

  it("strips but never uses a malformed or foreign code", () => {
    for (const bad of [
      "",
      "kdi_short",
      "kpi_AbCdEfGhIjKlMnOpQrSt",
      "kdi_AbCdEfGhIjKlMnOp<script>",
    ]) {
      expect(readInviteCode(`#invite=${encodeURIComponent(bad)}&x=1`)).toEqual({
        code: "",
        rest: "#x=1",
      });
    }
  });
});

describe("takeInviteFragment", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("returns the code and removes it from the address bar without a new history entry", () => {
    window.history.replaceState(null, "", `/chat?session=main#invite=${CODE}`);
    const before = window.history.length;
    expect(takeInviteFragment()).toBe(CODE);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("kdi_");
    expect(window.location.pathname + window.location.search).toBe("/chat?session=main");
    expect(window.history.length).toBe(before);
  });

  it("removes a malformed code and returns null", () => {
    window.history.replaceState(null, "", "/#invite=kdi_bad");
    expect(takeInviteFragment()).toBeNull();
    expect(window.location.href).not.toContain("kdi_");
  });

  it("leaves a link without an invite alone", () => {
    window.history.replaceState(null, "", "/#pair=kpi_abcdefgh12");
    expect(takeInviteFragment()).toBeNull();
    expect(window.location.hash).toBe("#pair=kpi_abcdefgh12");
  });
});

describe("isInviteToken", () => {
  it("recognises only a well-formed demo invite code", () => {
    expect(isInviteToken("kdi_AbCdEfGhIjKlMnOpQrSt")).toBe(true);
    expect(isInviteToken("kdi_short")).toBe(false);
    expect(isInviteToken("owner-token")).toBe(false);
    expect(isInviteToken("")).toBe(false);
    expect(isInviteToken(undefined)).toBe(false);
  });
});
