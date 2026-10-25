import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: { include: ["lit/directives/repeat.js", "lit/directives/live.js"] },
  test: {
    include: ["src/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
