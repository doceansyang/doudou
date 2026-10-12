// 量【空状态】节点的实际尺寸：在画布上右键新建一个节点 → 量 → 立刻删除。
// 目的：确认「图片生成 / 视频生成 / 上传图片 / 上传视频」的空节点已按 16:9（427×240）占位。
// ⚠️ 读 offsetWidth/offsetHeight（画布有 zoom，rect 会被缩放）。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const WANT_W = 427, WANT_H = 240;

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 25000 });
await page.locator(".projectEntry").first().click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 35000 });
await page.waitForTimeout(2500);

const before = await page.evaluate(() => [...document.querySelectorAll(".vue-flow__node")].map((n) => n.getAttribute("data-id")));
console.log("操作前节点数:", before.length);

/** 量所有「内容区」的尺寸，并标出哪些是空状态。 */
async function measure(tag) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".vue-flow__node")].map((el, i) => {
      const c = el.querySelector(".imageContent, .videoContent");
      if (!c) return null;
      const hasMedia = !!c.querySelector("img, video");
      return { i, id: el.getAttribute("data-id") ?? "", kind: c.className.toString().includes("video") ? "video" : "image", empty: !hasMedia, w: c.offsetWidth, h: c.offsetHeight, nodeW: el.offsetWidth };
    }).filter(Boolean));
  console.log(`--- ${tag} ---`);
  for (const r of rows) {
    const mark = r.empty ? (Math.abs(r.w - WANT_W) <= 3 && Math.abs(r.h - WANT_H) <= 3 ? "✅" : `✗ 期望 ${WANT_W}×${WANT_H}`) : "  ";
    console.log(`  ${r.kind.padEnd(5)} ${r.empty ? "空  " : "有内容"} ${String(r.w).padStart(4)}×${String(r.h).padStart(3)} 总宽=${String(r.nodeW).padStart(4)} ${mark}  ${r.id.slice(0, 8)}`);
  }
  return rows;
}

await measure("改动前 · 现有节点");

// 节点由外部脚本临时注入（id 以 probe- 开头），这里只负责量。
const probeRows = await page.evaluate(() =>
  [...document.querySelectorAll('.vue-flow__node')]
    .filter((el) => (el.getAttribute("data-id") ?? "").startsWith("probe-"))
    .map((el) => {
      const c = el.querySelector(".imageContent, .videoContent");
      if (!c) return { id: el.getAttribute("data-id"), kind: "?", empty: true, w: 0, h: 0, nodeW: el.offsetWidth };
      return {
        id: el.getAttribute("data-id"),
        kind: c.className.toString().includes("video") ? "video" : "image",
        empty: !c.querySelector("img, video"),
        w: c.offsetWidth, h: c.offsetHeight, nodeW: el.offsetWidth,
      };
    }));

console.log("\n=== 临时注入的空节点 ===");
let allOk = probeRows.length > 0;
for (const r of probeRows) {
  const ok = Math.abs(r.w - WANT_W) <= 3 && Math.abs(r.h - WANT_H) <= 3;
  allOk = allOk && ok;
  console.log(`  ${r.id.padEnd(30)} ${r.kind.padEnd(5)} 内容区 ${r.w}×${r.h}  节点总宽 ${r.nodeW}  ${ok ? "✅" : "✗ 期望 " + WANT_W + "×" + WANT_H}`);
}
console.log("判定 = " + (probeRows.length ? (allOk ? "✅ 空节点就是 16:9（427×240）" : "✗ 不符合预期") : "（没找到注入的节点）"));

console.log("页面错误:", errors.length ? errors.join(" | ") : "（无）");
console.log("截图:", join(outDir, "_empty-node-size.png"));
await browser.close();
