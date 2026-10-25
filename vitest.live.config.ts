import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    include: ["src/**/*.live.test.ts"],
    setupFiles: ["test/isolate-home.ts", "test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/KoLo.app/**",
    ],
  },
});
