import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：画布上「视频/图片」节点的预览尺寸是不是**短边 240**。
//
// 需求原话：「9:16 的尺寸改成现在 16:9 竖起来的尺寸，3:4 改成现在 4:3 竖起来的尺寸，
// 就是视觉上得差不多大」⇒ 短边固定 240：横版 427×240，竖版 240×427（面积相等）。
//
// ⚠️ 量尺寸**不能用 getBoundingClientRect**：画布有 zoom（适应视图后常是 53%），
//    rect 会被整体 scale 掉。要读布局尺寸就得用 offsetWidth/offsetHeight。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(600); }
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click().catch(() => {}); await page.waitForTimeout(1500); }
// 等视频元数据读完（resizeVideo 在 loadedmetadata 时跑）
await page.waitForTimeout(6000);

const nodes = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll(".vue-flow__node")) {
    const label = (el.querySelector(".nodeHeader, header, .nodeSkeleton__header")?.textContent || el.textContent || "").trim().slice(0, 24);
    const media = el.querySelector(".videoPlayer video, .imageEditor img");
    if (!media) continue;
    const host = el.querySelector(".videoPlayer, .imageEditor");
    // offset* 是布局尺寸，不受画布 zoom（transform:scale）影响
    out.push({
      label,
      mediaW: media.offsetWidth,
      mediaH: media.offsetHeight,
      hostW: host?.offsetWidth ?? 0,
      hostH: host?.offsetHeight ?? 0,
      nodeW: el.offsetWidth,
      nodeH: el.offsetHeight,
      natural: media.tagName === "VIDEO"
        ? [media.videoWidth, media.videoHeight]
        : [media.naturalWidth, media.naturalHeight],
      ratio: +(media.offsetWidth / media.offsetHeight).toFixed(3),
    });
  }
  return out;
});

// 画布 zoom（说明为什么必须读 offset 而不是 rect）
const zoom = await page.evaluate(() => {
  const vp = document.querySelector(".vue-flow__viewport");
  const m = vp && new DOMMatrixReadOnly(getComputedStyle(vp).transform);
  return m ? +m.a.toFixed(3) : 1;
});

console.log(`画布 zoom = ${zoom}（rect 会被它缩放，所以下面量的是 offset 布局尺寸）\n`);
console.log("节点                                   原始比例   预览(宽×高)     轴比    短边");
console.log("─".repeat(96));
for (const n of nodes) {
  const short = Math.min(n.mediaW, n.mediaH);
  const ar = n.natural[0] && n.natural[1] ? (n.natural[0] / n.natural[1]).toFixed(3) : "?";
  console.log(
    `${n.label.padEnd(34)}  ${String(ar).padStart(6)}   ` +
    `${String(n.mediaW).padStart(4)}×${String(n.mediaH).padEnd(5)}   ` +
    `${String(n.ratio).padStart(6)}   ${String(short).padStart(4)}`
  );
}
await page.screenshot({ path: join(outDir, "_preview-short-edge.png") });

// 竖版节点宽度从 135 → 240，**跨过了控件条的容器断点**（`@container (max-width:210px)`
// 会砍掉时间码与音量）。所以顺手确认：240px 下完整控件条放得下、不溢出、不压字。
const tallBox = await page.evaluate(() => {
  for (const el of document.querySelectorAll(".vue-flow__node")) {
    const v = el.querySelector(".videoPlayer video");
    if (v && v.offsetHeight > v.offsetWidth) { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; }
  }
  return null;
});
if (tallBox) {
  await page.mouse.move(tallBox.x, tallBox.y);
  await page.waitForTimeout(900);
  const fit = await page.evaluate(() => {
    const bar = [...document.querySelectorAll(".playerControls")].find((el) => el.getBoundingClientRect().width > 0);
    if (!bar) return null;
    const b = bar.getBoundingClientRect();
    const kids = [...bar.querySelectorAll(":scope > *")].filter((el) => el.getBoundingClientRect().width > 0);
    const rects = kids.map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.className.split(" ")[0] || el.tagName.toLowerCase(), l: r.left, r: r.right, w: r.width };
    });
    const overflow = rects.filter((x) => x.l < b.left - 0.5 || x.r > b.right + 0.5);
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], c = rects[j];
        if (Math.abs(a.l - c.l) < 1 && Math.abs(a.r - c.r) < 1) continue;   // 进度条与控件行不同行，跳过
        if (a.l < c.r - 1 && c.l < a.r - 1) overlaps++;
      }
    }
    return { barW: Math.round(b.width), shown: rects.map((x) => x.cls), overflow: overflow.map((x) => x.cls), overlaps };
  });
  await page.screenshot({ path: join(outDir, "_preview-portrait-node.png") });
  console.log("\n=== 竖版控件条（240px 宽，落在 210~320 的默认档）===");
  if (!fit) console.log("  ⚠️ 没找到可见的控件条（可能需要真的 hover 到节点上）");
  else {
    console.log(`  控件条宽度 ${fit.barW}px   可见控件: ${fit.shown.join(" / ")}`);
    console.log(`  溢出容器 = ${fit.overflow.length ? "✗ " + fit.overflow.join(",") : "✅ 无"}`);
    console.log(`  横向重叠 = ${fit.overlaps ? "✗ " + fit.overlaps + " 对" : "✅ 无"}`);
  }
}

console.log("\n=== 判定（短边应恒为 240）===");
const off = nodes.filter((n) => Math.abs(Math.min(n.mediaW, n.mediaH) - 240) > 3);
console.log(`  每个节点的预览短边都是 240 = ${off.length === 0 ? "✅" : "✗ " + JSON.stringify(off.map((n) => [n.label, Math.min(n.mediaW, n.mediaH)]))}`);
// 长边应 = 240 × max(比例, 1/比例)
const badLong = nodes.filter((n) => {
  const a = n.natural[0] && n.natural[1] ? n.natural[0] / n.natural[1] : 0;
  if (!a) return false;
  return Math.abs(Math.max(n.mediaW, n.mediaH) - 240 * Math.max(a, 1 / a)) > 3;
});
console.log(`  长边 = 240 × max(比例, 1/比例) = ${badLong.length === 0 ? "✅" : "✗ " + JSON.stringify(badLong.map((n) => [n.label, Math.max(n.mediaW, n.mediaH)]))}`);
const wide = nodes.filter((n) => n.ratio > 1.02);
const tall = nodes.filter((n) => n.ratio < 0.98);
console.log(`  横版 ${wide.length} 个，竖版 ${tall.length} 个，方形 ${nodes.length - wide.length - tall.length} 个`);
for (const n of [...wide, ...tall]) console.log(`    ${n.ratio > 1 ? "横" : "竖"} ${n.mediaW}×${n.mediaH}`);
// 互为倒数的比例对，面积必须相等（这是"视觉上一样大"的硬指标）。
// 比例是浮点，配对要留容差：1.333 × 0.750 = 1.0，1.778 × 0.563 = 1.001。
const uniq = [...new Map(nodes.map((n) => [n.ratio.toFixed(2), n])).values()];
const pairs = [];
for (let i = 0; i < uniq.length; i++) {
  for (let j = i + 1; j < uniq.length; j++) {
    if (Math.abs(uniq[i].ratio * uniq[j].ratio - 1) > 0.02) continue;
    const areaA = uniq[i].mediaW * uniq[i].mediaH;
    const areaB = uniq[j].mediaW * uniq[j].mediaH;
    pairs.push(`    ${uniq[i].mediaW}×${uniq[i].mediaH} ↔ ${uniq[j].mediaW}×${uniq[j].mediaH}  面积差 ${Math.abs(areaA - areaB)}px²`);
  }
}
console.log(`  互倒数比例对面积相等 = ${pairs.length ? "✅" : "（画布上暂时没有互为倒数的两种比例，跳过）"}`);
pairs.forEach((p) => console.log(p));
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
