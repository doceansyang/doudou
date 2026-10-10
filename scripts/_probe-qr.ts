/**
 * 二维码替换验证：三处都要显示同一张图片且**真的加载成功**。
 *   ① 设置 → 关于 → 微信交流群「展示二维码」
 *   ② 设置 → 关于 → 赞助商「成为赞助商」
 *   ③ 画布右下角帮助 → 「加入交流群」（弹窗）
 * 判据用 img.complete && naturalWidth>0 —— 只检查"元素存在"会把加载失败也算通过。
 *
 * 跑法：cd toonflow && bun scripts/_probe-qr.ts
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const VIEW = { width: 1600, height: 950 };
const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 当前页面上所有可见二维码图片的加载状态 */
const IMG_STATE = `(() => {
  const imgs = [...document.querySelectorAll("img")].filter((i) => (i.getAttribute("alt") || "").includes("二维码"));
  if (!imgs.length) return "(没有找到二维码 img)";
  return imgs.map((i) => {
    const r = i.getBoundingClientRect();
    return "alt=" + i.getAttribute("alt")
      + "  加载=" + (i.complete && i.naturalWidth > 0 ? "成功" : "失败")
      + "  原始尺寸=" + i.naturalWidth + "x" + i.naturalHeight
      + "  显示尺寸=" + Math.round(r.width) + "x" + Math.round(r.height)
      + "  可见=" + (r.width > 0 && r.height > 0);
  }).join("\\n");
})()`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  // 不要等节点 —— 画布可能是空的；等「设置」按钮出来就说明工作区已就绪。
  await page.waitForSelector('button[title^="设置"]', { timeout: 60000 });
  await page.waitForTimeout(4000);

  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator(".settingsItem").filter({ hasText: "关于" }).first().click();
  await page.waitForTimeout(2000);

  log("=== ① 微信交流群「展示二维码」===");
  await page.locator("button").filter({ hasText: "展示二维码" }).first().click();
  await page.waitForTimeout(2500);
  log(String(await page.evaluate(IMG_STATE)));
  await page.screenshot({ path: "assets/_qr-community.png", clip: { x: 700, y: 200, width: 700, height: 620 } });
  // 点空白处关掉弹层（Escape 有时关不掉 popover）
  await page.mouse.click(400, 820);
  await page.waitForTimeout(1500);

  log("");
  log("=== ② 赞助商「成为赞助商」===");
  await page.locator("button").filter({ hasText: "成为赞助商" }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  log(String(await page.evaluate(IMG_STATE)));
  await page.screenshot({ path: "assets/_qr-business.png", clip: { x: 600, y: 250, width: 800, height: 620 } });
  await page.mouse.click(400, 820);
  await page.waitForTimeout(1200);

  // 关掉设置，去画布看帮助弹窗
  await page.locator(".el-dialog__headerbtn").first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1800);

  log("");
  log("=== ③ 画布帮助 →「加入交流群」===");
  await page.locator('button[title*="帮助"], button[aria-label*="帮助"]').first().click({ timeout: 5000 }).catch(async () => {
    log("  (没找到帮助按钮，跳过)");
  });
  await page.waitForTimeout(1500);
  await page.locator("button").filter({ hasText: "加入交流群" }).first().click({ timeout: 5000 }).catch(() => log("  (没找到「加入交流群」)"));
  await page.waitForTimeout(2500);
  log(String(await page.evaluate(IMG_STATE)));
  await page.screenshot({ path: "assets/_qr-canvas.png" });
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_qr-probe.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
