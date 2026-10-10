/**
 * 确认缩放手柄已经真正渲染，并定位它的位置。
 * 输出：nodeResizeHandle 数量、其所属节点、以及 .nodeSkeleton 是否存在及其父元素。
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
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 200)}`));

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
await page.waitForTimeout(5000);

const nb = await page.locator(".vue-flow__node").first().boundingBox();
for (const [dx, dy] of [[0.5, 0.5], [0.5, 0.14], [0.3, 0.4]]) {
  await page.mouse.click(nb.x + nb.width * dx, nb.y + nb.height * dy);
  await page.waitForTimeout(900);
  if (await page.locator(".vue-flow__node.selected").count() > 0) break;
}

const info = await page.evaluate(() => {
  const chain = (el) => {
    const parts = [];
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) { parts.push(cur.className || cur.tagName); cur = cur.parentElement; }
    return parts.join(" < ");
  };
  const handles = Array.from(document.querySelectorAll(".nodeResizeHandle"));
  const skeletons = Array.from(document.querySelectorAll(".nodeSkeleton"));
  return {
    handleCount: handles.length,
    handleDetails: handles.slice(0, 2).map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        opacity: cs.opacity, cursor: cs.cursor, position: cs.position,
        chain: chain(el),
      };
    }),
    skeletonCount: skeletons.length,
    skeletonChains: skeletons.slice(0, 3).map((el) => chain(el)),
    selectedCount: document.querySelectorAll(".vue-flow__node.selected").length,
    nodeTypeOfFirst: document.querySelector(".vue-flow__node")?.className,
  };
});

log(`选中节点数: ${info.selectedCount}`);
log(`.nodeSkeleton 数量: ${info.skeletonCount}`);
info.skeletonChains.forEach((c, i) => log(`   [${i}] ${c}`));
log("");
log(`.nodeResizeHandle 数量: ${info.handleCount}`);
info.handleDetails.forEach((h, i) => {
  log(`   [${i}] rect=${JSON.stringify(h.rect)} opacity=${h.opacity} cursor=${h.cursor} position=${h.position}`);
  log(`       结构: ${h.chain}`);
});

writeFileSync("assets/_resize-check.txt", lines.join("\n") + "\n", "utf-8");
await browser.close();
