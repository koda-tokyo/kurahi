import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
// Finite local capture: closes both Chromium and the temporary Vite server on completion.
import { createServer } from "vite";
const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = path.resolve(root, "../apps/desktop/screenshots/industrial-0.4");
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1366, height: 768 },
    wide: { width: 1920, height: 1080 },
    mobile: { width: 390, height: 844 },
  })) {
    await page.setViewportSize(viewport);
    for (const view of ["workbench", "terminal", "voice"]) {
      await page.goto(`http://127.0.0.1:${port}/visual/industrial-workbench.html?view=${view}`);
      await page.waitForSelector(
        view === "terminal" ? ".project-terminal" : ".industrial-workbench",
      );
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) {
        throw new Error(`${view}/${name}: horizontal overflow`);
      }
      await page.screenshot({
        path: `${screenshots}/industrial-${view}-${name}.png`,
        fullPage: false,
      });
      await page.screenshot({
        path: `${screenshots}/industrial-${view}-${name}-full.png`,
        fullPage: true,
      });
      console.log(`${view}/${name}: no horizontal overflow`);
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await browser?.close();
  await server.close();
}
