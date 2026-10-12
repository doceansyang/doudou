import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：图片生成节点的「生成中动画」是否真的挂上去了。
//
// 关键手法：**把生成请求拦下来挂着不回**（route 既不 fulfill 也不 continue），
// 于是节点会稳稳停在 generating 状态，可以慢慢量、慢慢截图 ——
// **零花费、零出网**，不需要真的生成一张图（真生成约 ¥0.8）。
//
// 判据全部读真实 DOM：overlay 是否存在、覆盖的矩形、百分比是否在爬、
// 文案是不是图片侧的、丝带 canvas 有没有真的渲染出来。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push("console: " + m.text()); });

// 生成请求挂起：不 fulfill、不 continue、不 abort —— 永远 pending
let genRequests = 0;
await page.route("**/api/ai/media/generate", (route) => { genRequests++; /* 挂住 */ });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(600); }
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click().catch(() => {}); await page.waitForTimeout(1200); }

// 选中「图片生成」节点
const node = page.locator(".vue-flow__node").filter({ hasText: /图片生成/ }).first();
console.log("图片生成节点数:", await page.locator(".vue-flow__node").filter({ hasText: /图片生成/ }).count());
const box = await node.boundingBox();
await page.mouse.click(box.x + 24, box.y + 12);
await page.waitForTimeout(1500);

const read = () => page.evaluate(() => {
  const el = document.querySelector(".genOverlay");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const host = el.parentElement.getBoundingClientRect();
  const canvas = el.querySelector("canvas");
  return {
    box: [Math.round(r.width), Math.round(r.height)],
    host: [Math.round(host.width), Math.round(host.height)],
    pct: (el.querySelector(".genPercent")?.textContent || "").trim(),
    label: (el.querySelector(".genLabel")?.textContent || "").trim(),
    fill: el.querySelector(".genFill")?.style.transform || "",
    canvas: canvas ? [canvas.width, canvas.height] : null,
    backdrop: getComputedStyle(el.querySelector(".genBackdrop")).backgroundColor,
  };
});

console.log("点击前 overlay:", await read());

const send = node.locator('[aria-label="生成图片"]').first();
if (!(await send.count())) {
  console.log("⚠️ 找不到「生成图片」按钮 —— 节点可能没有提示词/模型");
  await page.screenshot({ path: join(outDir, "_image-gen-overlay.png") });
  await browser.close();
  process.exit(1);
}
await send.click();

// 逐帧观察：百分比必须在爬、文案必须是图片侧的
const samples = [];
for (const wait of [900, 1600, 3000, 4000, 6000]) {
  await page.waitForTimeout(wait);
  const d = await read();
  samples.push(d);
  console.log(`  t≈${samples.reduce((a, _, i) => a + [900, 1600, 3000, 4000, 6000][i], 0) / 1000}s  ` +
    (d ? `overlay ${d.box[0]}x${d.box[1]}（宿主 ${d.host[0]}x${d.host[1]}）  ${d.pct}  「${d.label}」  fill=${d.fill}  canvas=${JSON.stringify(d.canvas)}  底=${d.backdrop}`
       : "❌ 没有 overlay"));
}
await page.screenshot({ path: join(outDir, "_image-gen-overlay.png") });
await node.screenshot({ path: join(outDir, "_image-gen-overlay-node.png") });

console.log("\n=== 判定 ===");
const live = samples.filter(Boolean);
const nums = live.map((d) => parseFloat(d.pct) || 0);
console.log(`  overlay 出现           = ${live.length === samples.length ? "✅" : `✗（${live.length}/${samples.length} 帧）`}`);
console.log(`  百分比在爬升           = ${nums.length > 1 && nums.at(-1) > nums[0] ? `✅（${nums.join(" → ")}）` : "✗（" + nums.join(" → ") + "）"}`);
console.log(`  文案是图片侧           = ${live.some((d) => d.label.includes("图片")) ? "✅" : "✗"}`);
console.log(`  WebGL 丝带 canvas 存在 = ${live.some((d) => d.canvas) ? "✅" : "✗"}`);
console.log(`  覆盖整个内容区         = ${live.some((d) => Math.abs(d.box[0] - d.host[0]) < 2 && Math.abs(d.box[1] - d.host[1]) < 2) ? "✅" : "✗"}`);
console.log(`  生成请求数（挂起的）   = ${genRequests}（挂起即未出网、未计费）`);
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
