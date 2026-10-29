import { describe, expect, it } from "vitest";
import { checkOutboundArgs, isOutboundTool } from "./outbound-guard.js";
import {
  corporateNumberCheckDigit,
  detectPersonalData,
  isValidCorporateNumber,
  isValidMyNumber,
  myNumberCheckDigit,
  redactPersonalData,
} from "./personal-data.js";

// 123456789018: check digit 8 for 12345678901 (worked by hand from 番号法施行令 第8条).
const VALID_MY_NUMBER = "123456789018";
const INVALID_MY_NUMBER = "123456789012";
// 国税庁's own 法人番号.
const NTA_CORPORATE_NUMBER = "7000012050002";

const POLICY = {
  myNumber: "block",
  otherIdentifiers: "warn",
  redactExports: false,
  redactLogs: false,
} as const;
const KEY = Buffer.alloc(32, 7);

describe("マイナンバー check digit", () => {
  it("validates the 12th digit", () => {
    expect(myNumberCheckDigit("12345678901")).toBe(8);
    expect(isValidMyNumber(VALID_MY_NUMBER)).toBe(true);
    expect(isValidMyNumber(INVALID_MY_NUMBER)).toBe(false);
    expect(isValidMyNumber("1234 5678 9018")).toBe(true);
    expect(isValidMyNumber("１２３４５６７８９０１８")).toBe(true);
    expect(isValidMyNumber("12345678901")).toBe(false);
  });

  it("validates 法人番号 and never reads a 13-digit number as a 個人番号", () => {
    expect(corporateNumberCheckDigit("000012050002")).toBe(7);
    expect(isValidCorporateNumber(NTA_CORPORATE_NUMBER)).toBe(true);
    const found = detectPersonalData(`法人番号 ${NTA_CORPORATE_NUMBER} の取引先`);
    expect(found.map((f) => f.kind)).toEqual(["corporate_number"]);
    // A 13-digit run with an invalid corporate check digit is not a 個人番号 either.
    expect(
      detectPersonalData("番号 1123456789018 です").filter((f) => f.kind === "my_number"),
    ).toEqual([]);
    // The 12-digit tail of a grouped 13-digit number is not one.
    expect(detectPersonalData("7 0000 1205 0002").map((f) => f.kind)).toEqual(["corporate_number"]);
  });

  it("finds valid numbers in text, full width and grouped, and skips invalid ones", () => {
    const text = `個人番号: ${VALID_MY_NUMBER}、旧番号 ${INVALID_MY_NUMBER}、全角 １２３４－５６７８－９０１８`;
    const found = detectPersonalData(text).filter((f) => f.kind === "my_number");
    expect(found).toHaveLength(2);
    expect(text.slice(found[0].start, found[0].end)).toBe(VALID_MY_NUMBER);
    expect(found[1].value).toBe("１２３４－５６７８－９０１８");
  });

  it("does not match digits inside hex digests or ids", () => {
    expect(detectPersonalData(`sha256 a${VALID_MY_NUMBER}b and id w${VALID_MY_NUMBER}`)).toEqual(
      [],
    );
  });
});

describe("other Japanese identifiers", () => {
  it("detects passport, 在留カード, bank account, phone and email", () => {
    const text = [
      "旅券 TK1234567",
      "在留カード AB12345678CD",
      "三菱UFJ銀行 新宿支店 普通 1234567",
      "電話 03-1234-5678 / 090-1234-5678 / +81 90 1234 5678",
      "連絡先 taro.yamada@example.co.jp",
    ].join("\n");
    const kinds = detectPersonalData(text).map((f) => f.kind);
    expect(kinds).toEqual([
      "passport",
      "residence_card",
      "bank_account",
      "phone",
      "phone",
      "phone",
      "email",
    ]);
  });

  it("redacts with labels and keeps 法人番号", () => {
    const out = redactPersonalData(
      `番号 ${VALID_MY_NUMBER} 法人 ${NTA_CORPORATE_NUMBER} mail a@b.jp`,
    );
    expect(out.text).toBe(`番号 [マイナンバー] 法人 ${NTA_CORPORATE_NUMBER} mail [メールアドレス]`);
    expect(out.count).toBe(2);
  });
});

describe("outbound policy check", () => {
  it("blocks a valid マイナンバー in m365 send / draft arguments by default", () => {
    expect(isOutboundTool("m365_mail_send")).toBe(true);
    expect(isOutboundTool("m365_mail_create_draft")).toBe(true);
    expect(isOutboundTool("m365_mail_list")).toBe(false);
    const send = checkOutboundArgs(
      { to: ["a@example.com"], subject: "書類", body: `マイナンバーは ${VALID_MY_NUMBER} です` },
      POLICY,
      KEY,
    );
    expect(send.action).toBe("block");
    if (send.action === "block") {
      expect(send.reason).toContain("マイナンバー");
      expect(send.reason).not.toContain(VALID_MY_NUMBER);
    }
    const f = send.findings.find((x) => x.kind === "my_number")!;
    expect(f.field).toBe("body");
    expect(f.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(send.findings)).not.toContain(VALID_MY_NUMBER);
  });

  it("warns on other identifiers and allows an invalid check digit", () => {
    expect(checkOutboundArgs({ body: `番号 ${INVALID_MY_NUMBER}` }, POLICY, KEY).action).toBe(
      "allow",
    );
    expect(checkOutboundArgs({ body: "電話 090-1234-5678" }, POLICY, KEY).action).toBe("warn");
    expect(
      checkOutboundArgs({ body: `番号 ${VALID_MY_NUMBER}` }, { ...POLICY, myNumber: "warn" }, KEY)
        .action,
    ).toBe("warn");
    expect(
      checkOutboundArgs(
        { body: "電話 090-1234-5678" },
        { ...POLICY, otherIdentifiers: "block" },
        KEY,
      ).action,
    ).toBe("block");
  });
});
