import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = path.resolve(root, "../apps/desktop/screenshots");
const departments = [
  "secretariat",
  "finance",
  "admin",
  "hr",
  "planning",
  "it",
  "procurement",
  "sales",
  "marketing",
  "service",
  "operations",
  "legal",
  "product",
  "facilities",
  "quality",
];
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
});
let browser;
let checked = 0;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  for (const locale of ["en", "ja"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 390, 1440]) {
        for (const mode of ["enterprise", "sme"]) {
          await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
          await page.goto(
            `${origin}/visual/business-departments.html?locale=${locale}&theme=${theme}&mode=${mode}&department=finance`,
          );
          await page.waitForSelector(".business-departments__workspace");
          await page.evaluate(() => document.fonts.ready);
          for (const department of departments) {
            await page.locator(`[data-department="${department}"]`).click();
            await page.waitForFunction(
              (id) =>
                document
                  .querySelector(`[data-department="${id}"]`)
                  ?.getAttribute("aria-pressed") === "true",
              department,
            );
            const expectedRows =
              department === "secretariat" ? 10 : department === "finance" ? 4 : 2;
            if ((await page.locator("[data-department-item]").count()) !== expectedRows) {
              throw new Error(`Missing department rows: ${department}`);
            }
            if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
              throw new Error(`Overflow: ${locale}/${theme}/${width}/${mode}/${department}`);
            }
            checked++;
            if (
              width !== 320 &&
              mode === "enterprise" &&
              ["finance", "hr", "secretariat"].includes(department)
            ) {
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.screenshot({
                path: `${screenshots}/business-departments-${department}-${locale}-${theme}-${width}.png`,
                fullPage: true,
              });
            }
          }
          console.log(`15 departments: ${locale}/${theme}/${width}/${mode}, no overflow`);
        }
      }
    }
  }
  await page.locator('[data-department-mode="enterprise"]').click();
  if (
    (await page.locator('[data-department-mode="enterprise"]').getAttribute("aria-pressed")) !==
    "true"
  ) {
    throw new Error("Mode switch failed");
  }
  await page.locator('[data-department="all"]').click();
  await page.locator("[data-business-queue]").selectOption("finance-work");
  if ((await page.locator("[data-business-queue]").inputValue()) !== "finance-work") {
    throw new Error("Queue selection failed");
  }
  if ((await page.locator(".business-item").count()) !== 4) {
    throw new Error("Queue filtering failed");
  }
  await page.locator('[data-department="finance"]').click();
  await page.locator("[data-department-item]").first().click();
  if (
    !(await page.locator(".business-detail-panel h2").textContent())?.includes("10月分保守請求書")
  ) {
    throw new Error("Detail selection failed");
  }
  await page.locator('.business-departments__filters [name="search"]').fill("nonexistent");
  await page.locator('.business-departments__filters button[type="submit"]').click();
  if (await page.locator("[data-department-item]").count()) {
    throw new Error("Search filter failed");
  }
  await page.locator('.business-departments__filters [name="search"]').fill("");
  await page.locator('.business-departments__filters [name="status"]').selectOption("new");
  await page.locator('.business-departments__filters button[type="submit"]').click();
  if ((await page.locator("[data-department-item]").count()) !== 0) {
    throw new Error("Status filter failed");
  }
  await page.locator("[data-business-work-new]").click();
  await page.locator('.business-intake__form [name="title"]').fill("Fictional fixture creation");
  await page
    .locator('.business-intake__form [name="description"]')
    .fill("Testing presentation only, without a server action.");
  await page.locator('.business-intake__form button[type="submit"]').click();
  if (!(await page.locator(".business-decision__notice").textContent())?.includes("サーバー")) {
    throw new Error("Fixture action notice missing");
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  console.log(
    `${checked} department layouts checked; selection, search, status and form callbacks passed; no page or console errors.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
