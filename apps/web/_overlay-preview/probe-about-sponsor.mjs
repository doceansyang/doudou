import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：设置 → 关于 里的「赞助商」区块长什么样（回答"这个页面在哪"）。
// 现状：接口在 linke 上 404 ⇒ sponsors 恒为空 ⇒ 只剩标题 + 「成为赞助商」按钮。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);

const nav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "关于") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
if (!nav) throw new Error("设置面板里没找到「关于」");
await page.mouse.click(nav.x, nav.y);
await page.waitForTimeout(1500);

const panel = page.locator(".sponsorPanel").first();
await panel.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const el = document.querySelector(".sponsorPanel");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
    entries: el.querySelectorAll(".sponsorEntry").length,
    body: document.body.innerText.includes("关于"),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
});
console.log("赞助商区块：", JSON.stringify(info));
await panel.screenshot({ path: join(outDir, "about-sponsor-block.png") });
await page.screenshot({ path: join(outDir, "about-panel.png") });
console.log("已截图：scripts/_out/about-panel.png、about-sponsor-block.png");
await browser.close();
