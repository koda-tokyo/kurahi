import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_DIR } from "../src/config/paths.js";

describe("test home isolation", () => {
  it("module-level state paths point into the isolated test home, never the real one", () => {
    const realHome = os.userInfo().homedir;
    expect(STATE_DIR.startsWith(path.join(realHome, ".kolo"))).toBe(false);
  });
});
