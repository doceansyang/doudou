import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：定位「匿名使用统计」（埋点）在界面上的位置 —— 设置 → 隐私。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
// 直接看它到底发不发：拦截所有对外请求，统计有没有 telemetry。
const outbound = [];
page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:3000")) outbound.push(r.url()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.locator(".projectEntry").first().click().catch(() => {});   // 引导页没有项目卡，忽略
await page.locator('button[aria-label="设置"]').first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);
const nav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "隐私") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0; for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
if (!nav) throw new Error("没找到「隐私」导航项");
await page.mouse.click(nav.x, nav.y);
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({
  text: (document.querySelector(".privacy")?.innerText || "").replace(/\s+/g, " ").slice(0, 220),
  switchOn: document.querySelector(".privacy .el-switch")?.classList.contains("is-checked"),
}));
console.log("隐私面板:", JSON.stringify(info, null, 1));
console.log("对外请求:", JSON.stringify([...new Set(outbound)].slice(0, 6)));
await page.screenshot({ path: join(outDir, "settings-privacy.png") });
await browser.close();
