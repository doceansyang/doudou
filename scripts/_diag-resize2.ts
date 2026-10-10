/**
 * 精确定位：resizeHandle 元素的实际形态 + startResize 是否被触发。
 * 注意：page.evaluate 内部的回调会先被序列化成字符串，因此里面只写纯 JS，不写类型断言。
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
await page.waitForTimeout(4000);

const nb = await page.locator(".vue-flow__node").first().boundingBox();
await page.mouse.click(nb.x + nb.width / 2, nb.y + 16);
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".resizeHandle").forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push({
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      computed: { position: cs.position, width: cs.width, height: cs.height, cursor: cs.cursor, zIndex: cs.zIndex },
      attrs: Array.from(el.attributes).map((a) => a.name).filter((n) => n.indexOf("data-v") === 0),
      parent: el.parentElement ? el.parentElement.className : "",
      parentPosition: el.parentElement ? getComputedStyle(el.parentElement).position : "",
    });
  });
  const sk = document.querySelector(".nodeSkeleton");
  return {
    handles: out,
    skeletonPosition: sk ? getComputedStyle(sk).position : "(无)",
    styleTagsWithHandle: Array.from(document.querySelectorAll("style")).filter((s) => (s.textContent || "").indexOf("resizeHandle") >= 0).length,
  };
});

log("=== resizeHandle 实例 ===");
info.handles.forEach((h, i) => {
  log(`  [${i}] rect=${JSON.stringify(h.rect)}`);
  log(`      computed=${JSON.stringify(h.computed)}`);
  log(`      data-v 属性=${JSON.stringify(h.attrs)}  父元素=${h.parent}（position=${h.parentPosition}）`);
});
log("");
log(`.nodeSkeleton 的 position = ${info.skeletonPosition}`);
log(`含 resizeHandle 规则的 <style> 标签数 = ${info.styleTagsWithHandle}`);

const h = await page.locator(".resizeHandle").first().boundingBox();
if (h) {
  const before = await page.evaluate(() => document.body.style.cursor);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  const after = await page.evaluate(() => document.body.style.cursor);
  await page.mouse.up();
  log("");
  log("=== startResize 是否执行（body cursor 副作用）===");
  log(`  按下前 cursor="${before}"  按下后 cursor="${after}"`);
  log(`  判定: ${after === "nwse-resize" ? "✓ startResize 已执行（skeletonElement 正常）" : "❌ startResize 未执行或提前 return"}`);
}

writeFileSync("assets/_resize-diag2.txt", lines.join("\n") + "\n", "utf-8");
await browser.close();
