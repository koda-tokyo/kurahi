import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = path.resolve(root, "../apps/desktop/screenshots");
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
  for (const locale of ["en", "ja"]) {
    for (const [size, viewport, theme] of [
      ["desktop", { width: 1440, height: 1000 }, "dark"],
      ["mobile", { width: 390, height: 844 }, "dark"],
      ["desktop-light", { width: 1440, height: 1000 }, "light"],
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${port}/visual/business-workspace.html?locale=${locale}&theme=${theme}`,
      );
      await page.waitForSelector(".business-workspace");
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Business ${locale}/${size}: horizontal overflow`);
      await page.screenshot({
        path: `${screenshots}/business-${locale}-${size}.png`,
        fullPage: true,
      });
      console.log(`Business ${locale}/${size}/${theme}: no horizontal overflow`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  await server.close();
}
