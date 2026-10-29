import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.resolve(root, "../apps/desktop/screenshots/industrial-payroll");
await mkdir(destination, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date("2026-10-25T16:00:00Z"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const locale of ["en", "ja"]) {
    for (const [size, viewport] of Object.entries({
      desktop: { width: 1600, height: 1100 },
      mobile: { width: 390, height: 844 },
    })) {
      await page.setViewportSize(viewport);
      for (const view of ["workbench", "document", "change"]) {
        await page.goto(
          `http://127.0.0.1:${port}/visual/industrial-payroll.html?locale=${locale}&view=${view}`,
        );
        await page.waitForSelector('body[data-ready="true"]');
        await page.evaluate(() => document.fonts.ready);
        if (view === "document") {
          await page
            .locator(".ent-panel__body")
            .first()
            .evaluate((body) => {
              const heading = [...body.querySelectorAll("h3")].find((h) =>
                h.textContent?.startsWith("1.3"),
              );
              if (!heading) {
                throw new Error("Missing generated relationship citations");
              }
              body.scrollTop = heading.offsetTop - body.offsetTop;
            });
          assert.match(await page.locator(".ent-panel").first().innerText(), /PAYCALC\.cbl:140/);
          assert.match(await page.locator(".ent-panel").nth(1).innerText(), /140.*CALL 'PAYRND'/);
        }
        if (view === "change") {
          assert.equal(await page.locator(".ent-panel select").nth(0).inputValue(), "2");
          assert.equal(await page.locator(".ent-panel select").nth(1).inputValue(), "1");
          assert.equal(await page.locator(".ent-diff__add").count(), 1);
          assert.match(
            await page.locator(".ent-diff__add").innerText(),
            /ILLUSTRATIVE REVIEW COMMENT ONLY/,
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${locale}/${view}/${size}: overflow`,
        );
        await page.screenshot({
          path: `${destination}/${locale}-${view}-${size}.png`,
          fullPage: true,
        });
        console.log(`${locale}/${view}/${size}: capture OK`);
      }
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
