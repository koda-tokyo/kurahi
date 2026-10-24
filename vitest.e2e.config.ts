import os from "node:os";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
const e2eWorkers = isCI ? 2 : Math.min(4, Math.max(1, Math.floor(cpuCount * 0.25)));

export default defineConfig({
  // The package aliases (KoLo/plugin-sdk, the client sources) the unit config resolves; bundled
  // extensions import the plugin SDK by that name.
  resolve: baseConfig.resolve,
  test: {
    // Same budgets as the unit config: e2e hooks boot a gateway, which takes well over the
    // vitest defaults (5 s test, 10 s hook) on a loaded host.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: e2eWorkers,
    include: ["test/**/*.e2e.test.ts", "src/**/*.e2e.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/KoLo.app/**",
    ],
  },
});
