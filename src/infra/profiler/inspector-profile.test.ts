import { describe, expect, test } from "vitest";
import {
  captureInspectorProfile,
  clampProfileSeconds,
  defaultSamplingIntervalUs,
  isWsl,
  ProfileBusyError,
  startInspectorProfile,
} from "./inspector-profile.js";
import { parseProfileStartupArg } from "./startup-profile.js";

describe("inspector profile capture", () => {
  test("clamps the duration to 1-300 s", () => {
    expect(clampProfileSeconds(0)).toBe(1);
    expect(clampProfileSeconds(1000)).toBe(300);
    expect(clampProfileSeconds("abc")).toBe(10);
    expect(clampProfileSeconds(5)).toBe(5);
  });

  test("captures CPU and heap profiles and refuses a concurrent capture", async () => {
    const running = await startInspectorProfile({ heap: true, samplingIntervalUs: 100 });
    await expect(startInspectorProfile()).rejects.toBeInstanceOf(ProfileBusyError);
    let x = 0;
    for (let i = 0; i < 200_000; i += 1) {
      x += Math.sqrt(i);
    }
    expect(x).toBeGreaterThan(0);
    const result = await running.stop();
    expect(result.cpuProfile.nodes.length).toBeGreaterThan(0);
    expect(result.heapProfile?.head).toBeDefined();
    // Released: a new capture may start.
    const again = await captureInspectorProfile({ seconds: 1 });
    expect(again.cpuProfile.nodes.length).toBeGreaterThan(0);
  });

  test("uses a coarser default sampling interval on WSL", () => {
    expect(isWsl("6.6.87.2-microsoft-standard-WSL2", "linux")).toBe(true);
    expect(isWsl("6.8.0-45-generic", "linux")).toBe(false);
    expect(isWsl("23.1.0", "darwin")).toBe(false);
    expect(defaultSamplingIntervalUs({ KOLO_PROFILE_SAMPLING_INTERVAL_US: "250" })).toBe(250);
  });

  test("parses --profile-startup for gateway commands only", () => {
    expect(
      parseProfileStartupArg([
        "node",
        "kolo",
        "gateway",
        "run",
        "--profile-startup",
        "/tmp/a.cpuprofile",
      ]),
    ).toBe("/tmp/a.cpuprofile");
    expect(parseProfileStartupArg(["node", "kolo", "gateway", "--profile-startup=/tmp/b"])).toBe(
      "/tmp/b",
    );
    expect(
      parseProfileStartupArg(["node", "kolo", "status", "--profile-startup", "/tmp/c"]),
    ).toBeNull();
    expect(
      parseProfileStartupArg(["node", "kolo", "gateway", "--profile-startup", "--force"]),
    ).toBeNull();
  });
});
