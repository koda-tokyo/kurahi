import { describe, expect, it } from "vitest";
import { columnWord } from "./poly-impact.js";

describe("columnWord", () => {
  it("matches the column as a whole identifier", () => {
    expect(columnWord("CUST_ID").test("CUST_ID -> CUSTOMER.ID")).toBe(true);
    expect(columnWord("CUST_ID").test("OLD_CUST_ID -> CUSTOMER.ID")).toBe(false);
    expect(columnWord("cust_id", "i").test("where CUST_ID = ?")).toBe(true);
  });

  it("treats $ and # as identifier characters (Oracle, DB2)", () => {
    expect(columnWord("ACCT$NO").test("ACCT$NO -> LEDGER.ACCT$NO")).toBe(true);
    expect(columnWord("ACCT").test("ACCT$NO -> LEDGER.ACCT$NO")).toBe(false);
    expect(columnWord("ROW#").test("ROW# = 1")).toBe(true);
  });

  it("does not throw on, or interpret, regex syntax in a quoted identifier", () => {
    expect(() => columnWord("AMOUNT(JPY")).not.toThrow();
    expect(columnWord("A+B").test("A+B -> T.X")).toBe(true);
    expect(columnWord("A+B").test("AAB -> T.X")).toBe(false);
  });
});
