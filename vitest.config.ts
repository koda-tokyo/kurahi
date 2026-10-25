import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
// M8: explicit per-OS exclusions for the CI matrix (test/ci-os-skips.json), applied on every
// run so a local run on that OS matches CI. Each entry is a vitest exclude glob.
const osSkips: string[] = (() => {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "test", "ci-os-skips.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = parsed[process.platform];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
})();
const isWindows = process.platform === "win32";
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const ciWorkers = isWindows ? 2 : 3;

export default defineConfig({
  resolve: {
    alias: {
      "KoLo/plugin-sdk": path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      // Tests run against the client sources, so no build is needed before `vitest`.
      "@kodasoken/kurahi-client": path.join(repoRoot, "packages", "client", "src", "index.ts"),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: isWindows ? 180_000 : 120_000,
    pool: "forks",
    maxWorkers: isCI ? ciWorkers : localWorkers,
    include: [
      "src/**/*.test.ts",
      "extensions/**/*.test.ts",
      "packages/client/test/**/*.test.ts",
      "packages/legacy-analyzer/src/**/*.test.ts",
      "test/format-error.test.ts",
      "test/privacy-check.test.ts",
      "test/isolate-home.test.ts",
    ],
    setupFiles: ["test/isolate-home.ts", "test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/KoLo.app/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
      // Archived gateway-v2/v3/v4 sources: not built or shipped; their imports point at
      // modules that moved. Kept for reference only, so their tests are not part of any suite.

      ...osSkips,
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Entrypoints and wiring (covered by CI smoke + manual/e2e flows).
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/cli/**",
        "src/commands/**",
        "src/daemon/**",
        "src/hooks/**",
        "src/macos/**",

        // Some agent integrations are intentionally validated via manual/e2e runs.
        "src/agents/model-scan.ts",
        "src/agents/pi-embedded-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/skills-install.ts",
        "src/agents/pi-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/agents/tools/slack-actions.ts",

        // Gateway server integration surfaces are intentionally validated via manual/e2e runs.
        "src/gateway/control-ui.ts",
        "src/gateway/server-bridge.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/server-methods/talk.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",

        // Process bridges are hard to unit-test in isolation.
        "src/gateway/call.ts",
        "src/process/tau-rpc.ts",
        "src/process/exec.ts",
        // Interactive UIs/flows are intentionally validated via manual/e2e runs.
        "src/tui/**",
        "src/wizard/**",
        // Channel surfaces are largely integration-tested (or manually validated).
        "src/discord/**",
        "src/imessage/**",
        "src/signal/**",
        "src/slack/**",
        "src/browser/**",
        "src/channels/web/**",
        "src/telegram/index.ts",
        "src/telegram/proxy.ts",
        "src/telegram/webhook-set.ts",
        "src/telegram/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "src/gateway/protocol/**",
        "src/infra/tailscale.ts",
      ],
    },
  },
});
