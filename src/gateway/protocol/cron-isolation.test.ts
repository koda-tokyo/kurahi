import { describe, expect, it } from "vitest";
import { validateCronAddParams, validateCronUpdateParams } from "./index.js";

const addParams = (postToMainMode: unknown) => ({
  name: "ops",
  schedule: { kind: "cron", expr: "* * * * *" },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "hi" },
  isolation: { postToMainMode },
});

describe("cron isolation postToMainMode", () => {
  it.each(["none", "summary", "full"])("accepts %s on cron.add and cron.update", (mode) => {
    expect(validateCronAddParams(addParams(mode))).toBe(true);
    expect(
      validateCronUpdateParams({ id: "job-1", patch: { isolation: { postToMainMode: mode } } }),
    ).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(validateCronAddParams(addParams("quiet"))).toBe(false);
    expect(
      validateCronUpdateParams({ id: "job-1", patch: { isolation: { postToMainMode: "quiet" } } }),
    ).toBe(false);
  });
});
