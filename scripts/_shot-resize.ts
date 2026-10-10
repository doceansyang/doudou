/**
 * 生成一张「选中节点 → 右下角手柄显示 → 拖大」的效果图，供交付演示。
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const VIEW = { width: 1500, height: 900 };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
await page.waitForTimeout(5000);

await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
await page.keyboard.press("Control+0");
await page.waitForTimeout(2500);

const nodes = page.locator(".vue-flow__node");
const total = await nodes.count();
const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
let idx = -1, box = null;
for (let i = 0; i < total; i++) {
  const b = await nodes.nth(i).boundingBox();
  if (inside(b) && b.width > 150) { idx = i; box = b; break; }
}
console.log(`演示节点: #${idx}`);

for (const [dx, dy] of [[0.08, 0.07], [0.5, 0.1], [0.5, 0.5]]) {
  await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
  await page.waitForTimeout(800);
  if (await page.locator(".vue-flow__node.selected").count() > 0) break;
}
await page.waitForTimeout(600);

const hb = await nodes.nth(idx).locator(".nodeResizeHandle").first().boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.waitForTimeout(500);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 18, hb.y + hb.height / 2 + i * 14);
await page.mouse.up();
await page.waitForTimeout(1200);

await page.screenshot({ path: "assets/_resize-demo.png" });
const after = await nodes.nth(idx).locator(".nodeSkeleton").first().boundingBox();
console.log(`拖大后尺寸: ${Math.round(after.width)} × ${Math.round(after.height)}`);
await browser.close();
