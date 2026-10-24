// Node-only runner for the Control UI unit tests that do not need a browser
// (`npx vitest run --config vitest.node.config.ts`). The default config runs everything in
// Playwright Chromium. Excluded here, and run only by the browser config:
// - `*.browser.test.ts`
// - tests that need a DOM (document/window/DOMPurify): markdown, views/chat, views/cron,
//   app-settings (polling timers on window).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "src/**/*.browser.test.ts",
      "src/ui/markdown.test.ts",
      "src/ui/views/chat.test.ts",
      "src/ui/views/cron.test.ts",
      "src/ui/app-settings.test.ts",
    ],
    environment: "node",
  },
});
