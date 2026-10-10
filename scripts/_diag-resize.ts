/**
 * 诊断：缩放手柄被拖动时到底发生了什么。
 *   · 手柄能否收到 pointerdown
 *   · window 能否收到 pointermove
 *   · 拖完以后 node 元素的 style / 尺寸是否变化
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const lines: string[] = [];
const log = (t = "") => lines.push(t);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("console", (m) => { if (m.type() === "error") log(`  [console.error] ${m.text().slice(0, 160)}`); });
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 200)}`));

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
await page.waitForTimeout(4000);

const first = page.locator(".vue-flow__node").first();
const nb = await first.boundingBox();
await page.mouse.click(nb!.x + nb!.width / 2, nb!.y + 16);
await page.waitForTimeout(1200);

// 注入探针
await page.evaluate(() => {
  const w = window as any;
  w.__probe = { handleDown: 0, winMove: 0, winUp: 0, calls: [] };
  document.querySelectorAll(".resizeHandle").forEach((h) => {
    h.addEventListener("pointerdown", () => { w.__probe.handleDown += 1; });
    h.addEventListener("pointermove", () => { w.__probe.calls.push("handleMove"); });
  });
  window.addEventListener("pointermove", () => { w.__probe.winMove += 1; }, true);
  window.addEventListener("pointerup", () => { w.__probe.winUp += 1; }, true);
});

const handle = page.locator(".resizeHandle").first();
const hb = await handle.boundingBox();
log(`手柄数量: ${await page.locator(".resizeHandle").count()}`);
log(`手柄位置: ${hb ? `x=${Math.round(hb.x)} y=${Math.round(hb.y)} w=${hb.width} h=${hb.height}` : "取不到"}`);
log(`节点元素 class: ${await first.getAttribute("class")}`);
log(`节点内联 style（拖前）: ${(await first.getAttribute("style")) ?? "(空)"}`);
log(`.nodeSkeleton class（拖前）: ${await page.locator(".nodeSkeleton").first().getAttribute("class")}`);

if (hb) {
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(hb.x + hb.width / 2 + i * 16, hb.y + hb.height / 2 + i * 12);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
}

const probe = await page.evaluate(() => (window as any).__probe);
log("");
log("=== 事件统计 ===");
log(`  手柄收到 pointerdown: ${probe.handleDown}`);
log(`  window 收到 pointermove: ${probe.winMove}`);
log(`  window 收到 pointerup: ${probe.winUp}`);

const nb2 = await first.boundingBox();
log("");
log("=== 尺寸 ===");
log(`  拖前: ${Math.round(nb!.width)} × ${Math.round(nb!.height)}`);
log(`  拖后: ${Math.round(nb2!.width)} × ${Math.round(nb2!.height)}`);
log(`  节点内联 style（拖后）: ${(await first.getAttribute("style")) ?? "(空)"}`);
log(`  .nodeSkeleton class（拖后）: ${await page.locator(".nodeSkeleton").first().getAttribute("class")}`);

writeFileSync("assets/_resize-diag.txt", lines.join("\n") + "\n", "utf-8");
await browser.close();
