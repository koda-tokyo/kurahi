import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = path.resolve(root, "../apps/desktop/screenshots");
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const locale of ["en", "ja"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${origin}/visual/business-departments.html?locale=${locale}&theme=${theme}&department=finance`,
        );
        const entry = page.locator(".business-chat-entry");
        await entry.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await entry.locator(".business-chat-entry__prompts button").first().click();
        if (!(await entry.locator("textarea").inputValue())) {
          throw new Error("Prompt did not populate composer");
        }
        if (await entry.locator('[type="submit"]').isDisabled()) {
          throw new Error("Send remained disabled");
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Overflow ${locale}/${theme}/${width}`);
        }
        await entry.screenshot({
          path: `${screenshots}/business-chat-entry-${locale}-${theme}-${width}.png`,
        });
        await entry.locator('[type="submit"]').click();
        if (
          !(await entry.locator('[role="alert"]').textContent())?.includes(
            locale === "ja" ? "表示確認" : "Visual fixture",
          )
        ) {
          throw new Error("Fixture action missing");
        }
        console.log(
          `PASS ${locale}/${theme}/${width}: composer, prompt, send, overflow, screenshot`,
        );
      }
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await browser?.close();
  await server.close();
}
