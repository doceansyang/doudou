import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.locator('button[aria-label="设置"]').first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1500);
const labels = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("button,li,div,span").forEach((el) => {
    const t = (el.textContent || "").trim();
    if (!t || t.length > 8) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    out.push(t);
  });
  return [...new Set(out)];
});
console.log(JSON.stringify(labels));
await browser.close();
