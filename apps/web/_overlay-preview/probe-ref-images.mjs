import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：点「生成」时，**前端到底往 /api/ai/media/generate 里放了什么**。
//
// 手法：把请求拦下来**读 body 但不放行**（既不 fulfill 也不 continue），
// 所以既能看到真实请求体，又**零出网、零花费**。
// 目的：判断"模型没收到参考图"到底是前端没传、还是后端没带、还是上游没用上。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const captured = [];
await page.route("**/api/ai/media/generate", async (route) => {
  try { captured.push(route.request().postDataJSON()); } catch { captured.push({ "(解析失败)": route.request().postData() }); }
  // 故意不 fulfill / continue —— 请求挂住，绝不真的出网
});

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(600); }
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click().catch(() => {}); await page.waitForTimeout(1500); }

// ── ① 找出所有「图片生成」节点 ──
// ⚠️ 不能用 `[aria-label="生成图片"]` 找：节点**只有被选中时才渲染底栏**，
//    底栏里才有 prompt、参考图缩略图和生成按钮 —— 未选中时按钮根本不在 DOM 里。
//    所以先按标题文本定位节点，再逐个选中去看底栏。
const genIdx = await page.evaluate(() => [...document.querySelectorAll(".vue-flow__node")]
  .map((el, i) => ({ i, text: (el.textContent || "").replace(/\s+/g, " ").trim() }))
  .filter((n) => /图片生成/.test(n.text)).map((n) => n.i));
console.log("画布上的「图片生成」节点索引:", genIdx);

// ── ② 逐个选中，读底栏里的 prompt 与参考图数量 ──
let target = null, targetIndex = -1;
for (const i of genIdx) {
  const el = page.locator(".vue-flow__node").nth(i);
  const b = await el.boundingBox();
  if (!b) continue;
  await page.mouse.click(b.x + 24, b.y + 12);
  await page.waitForTimeout(1200);
  const info = await page.evaluate((idx) => {
    const node = document.querySelectorAll(".vue-flow__node")[idx];
    const ce = [...node.querySelectorAll('[contenteditable="true"], textarea, input')]
      .map((e) => (e.value || e.textContent || "").trim()).filter(Boolean);
    // 参考图缩略图：底栏里带 img 的小卡片
    const thumbs = [...node.querySelectorAll("img")].filter((im) => im.naturalWidth > 0).length;
    const hasSend = !!node.querySelector('[aria-label="生成图片"], [aria-label="停止生成"], [aria-label="局部重绘"]');
    return { prompt: ce.slice(0, 3), thumbs, hasSend, text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
  }, i);
  console.log(`  [${i}] 底栏prompt=${JSON.stringify(info.prompt)} 图=${info.thumbs} 有生成按钮=${info.hasSend}`);
  if (!target && (info.prompt.some((t) => /衣服/.test(t)) || info.text.includes("衣服"))) { target = el; targetIndex = i; }
  if (target) break;
}
if (!target) { // 兜底：取最后一个图片生成节点
  targetIndex = genIdx[genIdx.length - 1];
  target = page.locator(".vue-flow__node").nth(targetIndex);
  const b = await target.boundingBox();
  await page.mouse.click(b.x + 24, b.y + 12);
  await page.waitForTimeout(1200);
  console.log(`  （没找到含"衣服"的节点，兜底用 [${targetIndex}]）`);
} else {
  console.log(`\n选中含"衣服"的节点 [${targetIndex}]`);
}
await target.screenshot({ path: join(outDir, "_ref-node.png") }).catch(() => {});
await page.waitForTimeout(400);

// 该节点当前挂了几张参考图（看 prompt 区上方的缩略图卡片）
const refCards = await target.locator(".referenceItem, .referenceCard, [class*=reference] img").count();
console.log("节点上可见的参考图元素:", refCards);
await target.screenshot({ path: join(outDir, "_ref-node.png") }).catch(() => {});

const send = target.locator('[aria-label="生成图片"]').first();
if (!(await send.count())) {
  console.log("⚠️ 找不到生成按钮，可能节点没选中或已禁用");
} else {
  await send.click();
  await page.waitForTimeout(2500);
}

console.log("\n=== 被拦下的 /api/ai/media/generate 请求体 ===");
if (!captured.length) console.log("  （没有发出请求）");
for (const body of captured) {
  const brief = { ...body };
  if (Array.isArray(brief.images)) brief.images = brief.images.map(x => ({ ...x, data: x.data ? `…(${String(x.data).length} 字符)` : undefined }));
  console.log(JSON.stringify(brief, null, 1).slice(0, 1200));
  console.log("");
  const imgs = Array.isArray(body.images) ? body.images : [];
  console.log("=== 判定 ===");
  console.log(`  images 字段: ${Array.isArray(body.images) ? `${imgs.length} 项` : "**缺失/不是数组**"}`);
  for (const it of imgs) console.log(`    path=${it.path}  mimeType=${it.mimeType}`);
  console.log(`  → ${imgs.length ? "✅ 前端**已经**把参考图放进请求（问题不在前端）" : "✗ 前端**没有**传参考图（问题在前端）"}`);
}
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
