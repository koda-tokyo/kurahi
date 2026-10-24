// Builds the desktop frontend: the first-run screen (web/index.html) and the bundled Control UI
// (web/control.html, which loads ui/src unchanged after installing the keychain storage).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Control UI imports Google Fonts; the desktop app is offline and its CSP blocks it. */
function stripRemoteFontImports(): Plugin {
  // Matches `@import url("https://…");` and the minified `@import"https://…";`.
  const pattern = /@import\s*(?:url\(\s*)?(["'])https?:\/\/.*?\1\s*\)?\s*;/g;
  return {
    name: "kurahi-desktop-strip-remote-fonts",
    // Vite inlines CSS @imports itself, so strip from the emitted stylesheets.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css")) {
          const css = String(file.source);
          file.source = css.replace(pattern, "");
        }
      }
    },
  };
}

export default defineConfig({
  root: path.join(here, "web"),
  base: "./",
  publicDir: path.join(here, "web", "public"),
  plugins: [stripRemoteFontImports()],
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        index: path.join(here, "web", "index.html"),
        control: path.join(here, "web", "control.html"),
      },
    },
  },
  server: { host: "127.0.0.1", port: 5180, strictPort: true, fs: { allow: [path.join(here, "..", "..")] } },
});
