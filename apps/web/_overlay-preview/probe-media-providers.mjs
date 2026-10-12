import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：① 设置 → 媒体模型 里 Linke 是否出现且排最前；② 节点里的模型下拉是否把
// Linke 排在第一组。两处都是"看得见才算数"，所以直接读渲染出来的 DOM 文案。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.waitForTimeout(2500);

// ── ① 设置 → 媒体模型 ──────────────────────────────────────────
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(900);
const nav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "媒体模型") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
await page.mouse.click(nav.x, nav.y);
await page.locator(".providerList .providerItem").first().waitFor({ state: "visible", timeout: 20000 });
await page.waitForTimeout(1200);

const cards = await page.evaluate(() => Array.from(document.querySelectorAll(".providerList .providerItem")).map((el, i) => ({
  idx: i + 1,
  title: (el.querySelector(".el-card__body")?.innerText || "").replace(/\s+/g, " ").slice(0, 60),
})));
console.log("=== 设置 → 媒体模型（卡片顺序）===");
cards.forEach((c) => console.log(`  ${c.idx}. ${c.title}`));
const firstIsLinke = /Linke/.test(cards[0]?.title || "");
const hasLinke = cards.some((c) => /Linke/.test(c.title));
console.log(`  Linke 出现=${hasLinke}   排第一=${firstIsLinke} ${firstIsLinke ? "✅" : "⚠️"}`);
const listBox = await page.locator(".providerList").first().boundingBox();
await page.screenshot({ path: join(outDir, "_media-providers.png"), clip: { x: listBox.x, y: listBox.y, width: listBox.width, height: Math.min(listBox.height, 520) } });

// 关掉设置，回到画布
await page.keyboard.press("Escape");
await page.evaluate(() => {
  const mask = document.querySelector(".el-overlay-dialog, .el-overlay");
  if (mask) mask.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForTimeout(800);

// ── ② 节点里的模型下拉（视频节点的模型选择器）────────────────────
// ⚠️ 这个按钮在同页里有多份（隐藏的那份在 0,0）—— 按 aria-label 找完还要用
//    getBoundingClientRect 过滤出**真正可见**的那个，否则点它必然超时。
const btnPos = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll('button[aria-label="模型与推理设置"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) cands.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  return cands;
});
console.log("\n=== 节点模型下拉的分组顺序 ===");
console.log("  可见的模型选择器:", btnPos.length, "个");
let groups = [];
if (!btnPos.length) {
  console.log("  !! 没找到可见的模型选择器");
} else {
  await page.mouse.click(btnPos[0].x, btnPos[0].y);
  await page.waitForTimeout(1200);
  const pop = await page.evaluate(() => {
    // 分组标题在 Element Plus 里是 .el-select-group__title；分组弹层可能是自定义的，
    // 所以顺带把可见弹层的文本也捞一份，避免"选择器没命中就说没分组"。
    const titles = Array.from(document.querySelectorAll(".el-select-group__title"))
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => (el.textContent || "").trim());
    const poppers = Array.from(document.querySelectorAll(".el-popper, .el-popover"))
      .filter((el) => el.getBoundingClientRect().width > 0);
    const text = poppers.map((el) => (el.innerText || "").replace(/\n+/g, " | ")).join(" ‖ ").slice(0, 420);
    const box = poppers[0]?.getBoundingClientRect();
    return { titles, text, box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null };
  });
  groups = pop.titles;
  console.log("  分组标题:", JSON.stringify(groups));
  console.log("  弹层内容:", pop.text);
  if (pop.box) {
    await page.screenshot({
      path: join(outDir, "_node-model-groups.png"),
      clip: { x: Math.max(0, pop.box.x - 8), y: Math.max(0, pop.box.y - 8), width: pop.box.w + 16, height: Math.min(pop.box.h + 16, 620) },
    });
  }
}
const g0 = groups[0] || "";
console.log(`  第一组是 Linke/JinyuDream = ${/linke|jinyudream/i.test(g0)} ${/linke|jinyudream/i.test(g0) ? "✅" : "⚠️"}`);

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
