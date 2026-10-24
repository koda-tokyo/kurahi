import { describe, expect, test } from "vitest";
import { createStartupPhaseTimer, getLastStartupPhases } from "./startup-phases.js";

describe("startup phase timer", () => {
  test("records each phase as the time since the previous mark", () => {
    let t = 1000;
    const timer = createStartupPhaseTimer(
      () => t,
      () => 400,
    );
    t = 1010;
    timer.mark("config");
    t = 1060;
    timer.mark("plugins");
    const summary = timer.summary();
    expect(summary).toEqual({
      bootMs: 400,
      serverMs: 60,
      totalMs: 460,
      phases: [
        { name: "config", ms: 10 },
        { name: "plugins", ms: 50 },
      ],
    });
    expect(timer.format()).toBe(
      "startup: 460ms (boot 400ms + server 60ms) config=10ms plugins=50ms",
    );
    expect(getLastStartupPhases()).toEqual(summary);
  });
});
