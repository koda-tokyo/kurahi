import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
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
        await page.goto(`${origin}/visual/autopilot.html?locale=${locale}&theme=${theme}`);
        await page
          .getByRole("region", {
            name: locale === "ja" ? "オートパイロット" : "Autopilot",
            exact: true,
          })
          .waitFor();
        await page.evaluate(() => document.fonts.ready);
        const brief = page.locator("[data-autopilot-brief]");
        if (
          !(await brief.innerText()).includes(
            locale === "ja" ? "設備点検の承認" : "Approve equipment inspection",
          )
        ) {
          throw new Error("Caller brief missing");
        }
        await brief.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-brief-${locale}-${theme}-${width}.png`,
          ),
        });

        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Overflow ${locale}/${theme}/${width}`);
        }
        if (process.env.KOLO_VISUAL_BRIEF_ONLY === "1") {
          console.log(`PASS brief ${locale}/${theme}/${width}: caller content and no overflow`);
          continue;
        }
        await page
          .getByRole("button", { name: locale === "ja" ? "以前の実行" : "Older runs", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: locale === "ja" ? "最新の実行に戻る" : "Back to latest",
            exact: true,
          })
          .waitFor();
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`History overflow ${locale}/${theme}/${width}`);
        }
        await page
          .getByRole("button", {
            name: locale === "ja" ? "最新の実行に戻る" : "Back to latest",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: locale === "ja" ? "更新" : "Refresh", exact: true })
          .click();
        if ((await page.locator("#fixture").getAttribute("data-refreshed")) !== "true") {
          throw new Error("Refresh failed");
        }
        const edition = page.getByRole("combobox", {
          name: locale === "ja" ? "エディション" : "Edition",
          exact: true,
        });
        const area = page.locator("select").nth(1);
        await edition.selectOption("business");
        await area.selectOption("finance");
        const text = await page
          .getByRole("region", {
            name: locale === "ja" ? "オートパイロット" : "Autopilot",
            exact: true,
          })
          .innerText();
        if (
          !text.includes(locale === "ja" ? "請求書レビューの準備" : "Prepare invoice review") ||
          text.includes(locale === "ja" ? "設計レビューの準備" : "Prepare design review")
        ) {
          throw new Error("Edition/area filter did not isolate Finance");
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Filtered overflow ${locale}/${theme}/${width}`);
        }
        await page
          .locator("[data-autonomy]")
          .getByRole("heading", {
            name: locale === "ja" ? "自律レベルの提案" : "Autonomy proposals",
            exact: true,
          })
          .waitFor();
        if (!text.includes(locale === "ja" ? "引き上げの提案" : "Proposed increase")) {
          throw new Error("Proposal missing from filtered view");
        }
        await page.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-filtered-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("button", {
            name: locale === "ja" ? "実行の証跡を確認" : "Inspect run evidence",
            exact: true,
          })
          .click();
        const detail = page.getByRole("region", {
          name: locale === "ja" ? "実行の詳細" : "Run details",
          exact: true,
        });
        await detail.waitFor();
        if (
          !(await detail.innerText()).includes(
            locale === "ja"
              ? "証跡は検証に合格していません"
              : "Evidence has not passed verification",
          )
        ) {
          throw new Error("Fixture evidence was not shown as unverified");
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Evidence overflow ${locale}/${theme}/${width}`);
        }
        await page.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-evidence-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("button", {
            name: locale === "ja" ? "詳細を閉じる" : "Close details",
            exact: true,
          })
          .click();
        if (await detail.count()) {
          throw new Error("Close details failed");
        }
        await edition.selectOption("");
        await area.selectOption("");
        await page.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        const decline = page.getByRole("button", {
          name: locale === "ja" ? "提案を却下" : "Decline proposal",
          exact: true,
        });
        if (!(await decline.isDisabled())) {
          throw new Error("Empty decline reason enabled submit");
        }
        await page
          .getByRole("region", {
            name: locale === "ja" ? "自律レベルの提案" : "Autonomy proposals",
            exact: true,
          })
          .getByRole("textbox")
          .fill("Review before changing autonomy");
        if (await decline.isDisabled()) {
          throw new Error("Valid decline reason did not enable submit");
        }
        await decline.click();
        if (
          !(await page.locator("#fixture").innerText()).includes("Review before changing autonomy")
        ) {
          throw new Error("Decline reason missing");
        }
        if (await decline.count()) {
          throw new Error("Declined proposal still actionable");
        }
        const design = page.locator('[data-routine-id="fictional-design-review"]');
        const finance = page.locator('[data-routine-id="fictional-finance-review"]');
        const resume = design.getByRole("button");
        if (!(await resume.isDisabled())) {
          throw new Error("Watchdog resume enabled without a reason");
        }
        await design.getByRole("textbox").fill("Verified source documents");
        if (await resume.isDisabled()) {
          throw new Error("Watchdog resume still disabled with valid reason");
        }
        await resume.click();
        if (!(await design.innerText()).includes(locale === "ja" ? "一時停止なし" : "Not paused")) {
          throw new Error("Resume did not update displayed routine state");
        }
        const pause = finance.getByRole("button");
        if (!(await pause.isDisabled())) {
          throw new Error("Pause enabled without a reason");
        }
        await finance.getByRole("textbox").fill("Review invoice policy");
        await pause.click();
        if (!(await finance.innerText()).includes("Review invoice policy")) {
          throw new Error("Pause reason missing from routine");
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Control feedback overflow ${locale}/${theme}/${width}`);
        }
        await page.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-controls-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        await page.goto(`${origin}/visual/autopilot.html?locale=${locale}&theme=${theme}`);
        const accept = page.locator("[data-accept-proposal]");
        await accept.waitFor();
        if (!(await accept.isDisabled())) {
          throw new Error("Accept enabled without a reason");
        }
        await page
          .locator("[data-autonomy] textarea")
          .fill("Verified the proposed level and evidence");
        if (await accept.isDisabled()) {
          throw new Error("Accept remained disabled with a valid reason");
        }
        await accept.click();
        await page
          .getByText(
            locale === "ja"
              ? "提案レベルを承認しました。更新されたルーチンを確認してください。"
              : "Proposed level accepted. Review the refreshed routine.",
            { exact: true },
          )
          .waitFor();
        if (!(await accept.isDisabled())) {
          throw new Error("Next proposal exceeding the ceiling remained acceptable");
        }
        if (
          !(
            await page
              .locator('[data-routine-id="fictional-design-review"] [data-autonomy-levels]')
              .innerText()
          ).includes("L2")
        ) {
          throw new Error("Accepted level was not displayed on the routine");
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
          throw new Error(`Accept feedback overflow ${locale}/${theme}/${width}`);
        }
        await page.screenshot({
          path: path.resolve(
            root,
            `../apps/desktop/screenshots/autopilot-accept-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        console.log(
          `PASS ${locale}/${theme}/${width}: overflow (latest + history + filtered), paging, refresh, edition/area filters, evidence inspection/close, decline reason validation, watchdog resume and pause reason validation, explicit acceptance, ceiling blocker and recorded feedback`,
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
