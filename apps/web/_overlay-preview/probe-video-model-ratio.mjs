// 验证「视频节点的模型下拉 + 比例选项」是否与「设置里的模型声明」一一对应。
//   node:  bun 无关 —— 直接 node probe-video-model-ratio.mjs
// 前置：应用在跑（127.0.0.1:3000），且项目里有视频生成节点。
import { chromium } from "playwright";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text()); });

// 服务有可能刚好在重启窗口里（本机启动器会被工具宿主回收）—— 重试几次，别一上来就判定失败。
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto("http://127.0.0.1:3000/", { waitUntil: "load", timeout: 30000 });
    break;
  } catch (error) {
    if (attempt >= 6) throw error;
    console.log(`  goto 失败（第 ${attempt} 次）：${String(error).slice(0, 90)}，3 秒后重试`);
    await page.waitForTimeout(3000);
  }
}

// 首页 → 点第一张项目卡进工作区。
// ⚠️ 用 `waitForFunction` 轮询 DOM 数量，别用 locator 的 state:"visible" ——
//    画布节点带 transform/opacity 过渡，Playwright 的可见性判定会一直不成立（实测等到超时，
//    而同一时刻 DOM 里其实已经有 17 个节点）。
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
if (await entry.count()) await entry.click().catch(() => {});
try {
  await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
} catch {
  const state = await page.evaluate(() => ({
    url: location.href,
    entries: document.querySelectorAll(".projectEntry").length,
    nodes: document.querySelectorAll(".vue-flow__node").length,
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
  }));
  console.log("!! 进工作区失败：", JSON.stringify(state, null, 1));
  await page.screenshot({ path: join(outDir, "_video-model-ratio-fail.png") });
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(3000);

// ⚠️ 点击前的两个必要准备：
//  1. Agent 面板**默认展开**且占住右侧 → 画布节点可能被它盖住，点击会被判「被 <html> 拦截」。
//  2. 画布可能被平移/缩放到节点在视口外 —— 画布不能用 scrollIntoView 救，必须点「适应视图」。
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
await closeBtn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
if (await closeBtn.count()) {
  await closeBtn.click().catch(() => {});
  await page.waitForTimeout(800);
  console.log("  已收起 Agent 面板");
}
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) {
  await fit.click().catch(() => {});
  await page.waitForTimeout(1500);
  console.log("  已点「适应视图」");
}

// ⚠️ 两个坑：
//  1. 视频节点与图片节点都有 `.modelSelect`，不能靠它区分。用**标题文案**定位（画布上节点头写着
//     「视频生成｜…」），这也是用户实际看到的。
//  2. 节点底栏（含模型下拉、生成设置按钮）是 `v-model:bottomVisible="node.selected"` ——
//     **不先选中节点，这些元素根本不在 DOM 里**，只会看到"等不到元素"。
const videoNode = page.locator(".vue-flow__node").filter({ hasText: /视频生成/ }).first();
const nodeCount = await videoNode.count();
console.log("视频生成节点数量:", nodeCount);
if (!nodeCount) {
  const titles = await page.evaluate(() => Array.from(document.querySelectorAll(".vue-flow__node"))
    .map((n) => (n.innerText || "").replace(/\s+/g, " ").slice(0, 30)));
  console.log("!! 没找到「视频生成」节点。画布上的节点：", JSON.stringify(titles));
  await browser.close();
  process.exit(2);
}
// 点节点头部把它选中（避开内部控件）；用鼠标坐标点，绕开 actionability 的“被遮挡”误判。
const box = await videoNode.boundingBox();
if (!box) {
  console.log("!! 节点没有可见矩形");
  await browser.close();
  process.exit(2);
}
console.log(`  节点矩形: x=${Math.round(box.x)} y=${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
await page.mouse.click(box.x + 24, box.y + 12);
await page.waitForTimeout(1800);
const selected = await page.evaluate(() => !!document.querySelector('[aria-label="视频生成设置"]'));
console.log("  选中后底栏出现=", selected, selected ? "✅" : "✗（模型下拉与设置按钮都在底栏里）");

// ── 1) 模型下拉：分组与分组内的模型 ──────────────────────────────────────
const select = videoNode.locator(".modelSelect").first();
await select.click();
await page.waitForTimeout(1200);

const groups = await page.evaluate(() => {
  const poppers = Array.from(document.querySelectorAll(".el-select-dropdown"))
    .filter((el) => el.getBoundingClientRect().width > 0);
  const root = poppers[poppers.length - 1];
  if (!root) return [];
  // ⚠️ 分组标题不是 `.el-select-group__title` 的 textContent —— Element Plus 这里
  //    渲染出来的节点文案取不到（实测为空串）。改从整个分组元素的 innerText 取首行。
  return Array.from(root.querySelectorAll(".el-select-group")).map((g) => {
    const first = (g.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
    const titleEl = g.querySelector(".el-select-group__title");
    return {
      title: first,
      rawTitle: titleEl ? (titleEl.textContent || "").trim() : null,
      items: Array.from(g.querySelectorAll(".el-select-dropdown__item")).map((i) => (i.textContent ?? "").trim()),
    };
  });
});
console.log("\n=== 视频节点的模型下拉 ===");
for (const g of groups) console.log(`  [${g.title}] ${g.items.join(" / ")}`);
if (groups[0]?.rawTitle !== undefined) console.log("  （分组标题元素的原始文案:", JSON.stringify(groups[0].rawTitle), "）");

// Linke 按优先级应排**第一组**；用「第一组的内容」判定，不依赖分组标题文案。
const EXPECT_LINKE = ["Grok Video 1.5", "Seedance 2.0", "Seedance 2.0 Mini", "Wan 3.0"];
const first = groups[0];
const firstIsLinke = !!first && first.items.length === 4 && EXPECT_LINKE.every((label) => first.items.includes(label));
const noText = !!first && !first.items.some((t) => /deepseek/i.test(t));
const noImage = !!first && !first.items.some((t) => /gpt-image/i.test(t));
console.log(`  第一组就是 Linke 且恰好 4 个视频模型=${firstIsLinke ? "✅" : "✗"}`);
console.log(`  未混入文本模型(deepseek-flash)=${noText ? "✅" : "✗"}`);
console.log(`  未混入图片模型(gpt-image-2)=${noImage ? "✅" : "✗"}`);
const linke = firstIsLinke ? first : groups.find((g) => /linke|jinyudream/i.test(g.title)) ?? first;

// 选一个 Linke 的视频模型（有 21:9 的那个），用来验证比例是模型驱动的
const target = linke?.items.find((t) => /seedance/i.test(t)) ?? linke?.items[0];
if (!target) {
  console.log("!! Linke 组里没有可选模型");
  await browser.close();
  process.exit(2);
}
await page.locator(".el-select-dropdown__item", { hasText: new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).last().click();
await page.waitForTimeout(800);
console.log(`\n  已选择：${target}`);

// ── 2) 生成设置里的比例选项（应来自模型声明，而不是通用兜底列表） ────────
await videoNode.locator('[aria-label="视频生成设置"]').first().click();
await page.waitForTimeout(900);
const ratios = await page.evaluate(() => {
  const pop = Array.from(document.querySelectorAll(".el-popover, .el-popper"))
    .filter((el) => el.getBoundingClientRect().width > 0)
    .pop();
  if (!pop) return null;
  const box = pop.querySelector('[aria-label="视频比例"]');
  if (!box) return null;
  return {
    ratios: Array.from(box.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()),
    durations: Array.from(pop.querySelectorAll('[aria-label="视频时长"] .el-select__selected-item, [aria-label="视频时长"] input'))
      .map((e) => (e.value ?? e.textContent ?? "").trim()).filter(Boolean),
    resolutions: Array.from(pop.querySelectorAll('[aria-label="视频分辨率"] .el-select__selected-item, [aria-label="视频分辨率"] input'))
      .map((e) => (e.value ?? e.textContent ?? "").trim()).filter(Boolean),
  };
});
console.log("\n=== 节点的生成设置（选中 Linke 模型后）===");
console.log("  比例:", JSON.stringify(ratios?.ratios));
console.log("  时长:", JSON.stringify(ratios?.durations));
console.log("  分辨率:", JSON.stringify(ratios?.resolutions));
const has219 = !!ratios?.ratios?.includes("21:9");
console.log(`  含 21:9（只有模型声明里才有）=${has219 ? "✅ 说明比例来自模型" : "✗ 用的还是通用兜底列表"}`);

await page.screenshot({ path: join(outDir, "_video-model-ratio.png") });

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
