// 量「空状态」节点的实际尺寸：应当与 16:9 横版预览一致（427×240）。
// ⚠️ 必须读 offsetWidth/offsetHeight —— 画布有 zoom，getBoundingClientRect 会被整体缩放。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const WANT_W = 427;   // PREVIEW_WIDTH_16_9 = round(240 * 16 / 9)
const WANT_H = 240;   // PREVIEW_SHORT_EDGE

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 25000 });
const names = (await page.locator(".projectEntry").allInnerTexts()).map((n) => n.replace(/\s+/g, " ").trim().slice(0, 18));
console.log("项目列表:", JSON.stringify(names));
// 优先打开临时项目「尺寸探针」（里面全是**空状态**节点）
const target = page.locator(".projectEntry").filter({ hasText: /尺寸探针/ }).first();
if (await target.count()) await target.click();
else {
  console.log("⚠️ 没找到「尺寸探针」项目，退回第一个项目");
  await page.locator(".projectEntry").first().click();
}
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 35000 });
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".vue-flow__node").forEach((el, i) => {
    const content = el.querySelector(".imageContent, .videoContent");
    if (!content) return;
    // 空状态：内容区里没有真正的 img/video 元素（只有占位图标）
    const hasMedia = !!content.querySelector("img, video");
    out.push({
      i,
      kind: (content.className || "").toString().includes("video") ? "video" : "image",
      empty: !hasMedia,
      w: content.offsetWidth,
      h: content.offsetHeight,
      nodeW: el.offsetWidth,
      label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 26),
    });
  });
  return out;
});

console.log("=== 节点内容区实际尺寸（offset，已排除画布 zoom）===");
for (const r of rows) {
  const tag = r.empty ? "空  " : "有内容";
  const note = r.empty
    ? (Math.abs(r.w - 427) <= 3 && Math.abs(r.h - 240) <= 3 ? "✅ 427×240" : `✗ 期望 427×240，实为 ${r.w}×${r.h}`)
    : "";
  console.log(`  [${String(r.i).padStart(2)}] ${r.kind.padEnd(5)} ${tag} ${String(r.w).padStart(4)}×${String(r.h).padStart(3)}  总宽=${String(r.nodeW).padStart(4)}  ${r.label} ${note}`);
}

const empties = rows.filter((r) => r.empty);
console.log(`\n空节点 ${empties.length} 个`);
console.log("全部空节点都是 427×240 = " + (empties.length && empties.every((r) => Math.abs(r.w - 427) <= 3 && Math.abs(r.h - 240) <= 3) ? "✅" : empties.length ? "✗" : "（画布上没有空节点，无法判定）"));
console.log("页面错误:", errors.length ? errors.join(" | ") : "（无）");

await page.screenshot({ path: join(outDir, "_node-default-size.png") });
console.log("截图:", join(outDir, "_node-default-size.png"));
await browser.close();
