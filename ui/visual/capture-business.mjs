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
      if (overflow) {
        throw new Error(`Business ${locale}/${size}: horizontal overflow`);
      }
      await page.screenshot({
        path: `${screenshots}/business-${locale}-${size}.png`,
        fullPage: true,
      });
      console.log(`Business ${locale}/${size}/${theme}: no horizontal overflow`);
    }
    for (const [size, viewport, routeTheme] of [
      ["desktop", { width: 1440, height: 1000 }, "light"],
      ["desktop-dark", { width: 1440, height: 1000 }, "dark"],
      ["mobile", { width: 390, height: 844 }, "light"],
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${port}/visual/business-workspace.html?locale=${locale}&theme=${routeTheme}&route=staged`,
      );
      await page.waitForSelector(".business-route");
      await page.evaluate(() => document.fonts.ready);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        throw new Error(`Business route ${locale}/${size}: horizontal overflow`);
      }
      await page.locator(".business-route").screenshot({
        path: `${screenshots}/business-route-${locale}-${size}.png`,
      });
      console.log(`Business route ${locale}/${size}: no horizontal overflow`);
    }
    for (const action of ["edit", "submit"]) {
      for (const [size, viewport] of [
        ["desktop", { width: 1440, height: 1000 }],
        ["mobile", { width: 390, height: 844 }],
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(
          `http://127.0.0.1:${port}/visual/business-workspace.html?locale=${locale}&theme=light&expenseAction=${action}`,
        );
        await page.waitForSelector(".business-intake__form");
        await page.evaluate(() => document.fonts.ready);
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Business expense ${action} ${locale}/${size}: horizontal overflow`);
        }
        await page.locator(".business-intake").screenshot({
          path: `${screenshots}/business-expense-${action}-${locale}-${size}.png`,
        });
        console.log(`Business expense ${action} ${locale}/${size}: no horizontal overflow`);
      }
    }
    for (const [size, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${port}/visual/business-workspace.html?locale=${locale}&theme=light&intake=expense`,
      );
      await page.waitForSelector(".business-intake__form");
      await page.evaluate(() => document.fonts.ready);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        throw new Error(`Business intake ${locale}/${size}: horizontal overflow`);
      }
      await page
        .locator(".business-intake")
        .screenshot({ path: `${screenshots}/business-intake-${locale}-${size}.png` });
      console.log(`Business intake ${locale}/${size}/light: no horizontal overflow`);
    }
    for (const [size, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${port}/visual/business-workspace.html?locale=${locale}&theme=light&decision=approve`,
      );
      await page.waitForSelector(".business-decision__form");
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) {
        throw new Error(`Business decision ${locale}/${size}: horizontal overflow`);
      }
      await page
        .locator(".business-decision")
        .screenshot({ path: `${screenshots}/business-decision-${locale}-${size}.png` });
      console.log(`Business decision ${locale}/${size}/light: no horizontal overflow`);
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await browser?.close();
  await server.close();
}
