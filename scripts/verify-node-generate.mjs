/**
 * 端到端验证（用户视角）：在 Toonflow 画布上
 *   双击空白 → 建「视频生成」节点 → 选豆包免费模型 → 填提示词 → 点生成 → 节点里出片
 *
 * 这是「节点级无缝对接」的最终验收。
 * 用法：bun run scripts/verify-node-generate.mjs
 */
const { chromium } = await import("playwright");
const { mkdir, writeFile } = await import("node:fs/promises");

const SHOT_DIR = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/assets/doubao-inspect";
await mkdir(SHOT_DIR, { recursive: true });

const MODEL_LABEL = "豆包 Seedance 2.0 Fast（免费）";
const PROMPT = "一只橘猫趴在洒满阳光的窗台上打盹，尾巴轻轻晃动，治愈系插画风格，暖色调";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1760, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)));
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon/.test(r.url())) console.log(`[HTTP ${r.status()}]`, r.url().slice(0, 110));
});

const step = (n, text) => console.log(`\n[${n}] ${text}`);

const nodeIds = () =>
  page.evaluate(() => [...document.querySelectorAll(".vue-flow__node")].map((el) => el.getAttribute("data-id")));

// 盯住生成请求，确认点击按钮后是否真的打到了后端
page.on("request", (r) => {
  if (r.url().includes("/api/ai/media/generate")) console.log("   [REQ] 已发出 /api/ai/media/generate");
});
page.on("response", (r) => {
  if (r.url().includes("/api/ai/media/generate")) console.log("   [RES]", r.status(), "← /api/ai/media/generate");
});

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "load", timeout: 40000 });
await page.locator(".vue-flow__pane").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(5000);

// 画布是 Toonflow 的引导画布，自带文本/图片/音频等种子节点，
// 所以必须对比「建节点前后」的 data-id，精确锁定新建的那一个。
const beforeIds = await nodeIds();
console.log("画布既有节点数 :", beforeIds.length);

// ── 1. 建视频生成节点 ─────────────────────────────────────
step(1, "双击空白 → 添加「视频生成」节点");
const pane = await page.locator(".vue-flow__pane").first().boundingBox();

/** 画布上可能残留上次验证建的节点，所以要探测一个真正空白的落点。 */
async function blankSpot() {
  // 优先视口中央偏上：节点从落点向下生长，这样参数面板能完整留在屏幕内。
  for (const [fx, fy] of [[0.5, 0.28], [0.35, 0.28], [0.66, 0.28], [0.5, 0.12], [0.12, 0.12], [0.88, 0.12]]) {
    const x = pane.x + pane.width * fx;
    const y = pane.y + pane.height * fy;
    const hit = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el ? String(el.className) : "none";
    }, [x, y]);
    if (hit.includes("vue-flow__pane")) return [x, y];
  }
  return null;
}

let menuItem = null;
for (let attempt = 1; attempt <= 3 && !menuItem; attempt += 1) {
  const spot = await blankSpot();
  if (!spot) {
    console.log(`   第 ${attempt} 次：找不到空白落点，跳过`);
    continue;
  }
  await page.mouse.dblclick(spot[0], spot[1]);
  await page.waitForTimeout(1500);
  const item = page.locator(".el-dropdown-menu__item", { hasText: "视频生成" }).first();
  if (await item.count()) menuItem = item;
  else console.log(`   第 ${attempt} 次：菜单未弹出（落点 ${Math.round(spot[0])},${Math.round(spot[1])}），换个位置重试`);
}
if (!menuItem) {
  console.log("   ✗ 节点菜单始终没弹出，中止");
  await browser.close();
  process.exit(1);
}
await menuItem.click();
await page.waitForTimeout(5000);

// 用 data-id 精确定位刚建出来的那个节点
const afterIds = await nodeIds();
const newId = afterIds.find((id) => !beforeIds.includes(id));
if (!newId) {
  console.log("   ✗ 没能识别出新节点，中止");
  await browser.close();
  process.exit(1);
}
const node = page.locator(`.vue-flow__node[data-id="${newId}"]`);
await node.waitFor({ timeout: 20000 });

// 节点默认是缩略态，必须点一下选中，底部参数面板才会展开
await node.click({ position: { x: 30, y: 10 } });
await page.waitForTimeout(1500);

// 若参数面板仍落在屏幕外，再用「适应视图」把它拉回来
const selectBox = await node.locator(".modelSelect").boundingBox().catch(() => null);
if (!selectBox || selectBox.y + selectBox.height > 1030 || selectBox.y < 0) {
  await page.locator('[aria-label="适应视图"]').first().click();
  await page.waitForTimeout(1800);
  console.log("   ✓ 节点已建出，并已适应视图");
} else {
  console.log("   ✓ 节点已建出（参数面板已在视口内）");
}
console.log("   新节点 id :", newId, "｜画布节点总数 :", afterIds.length);

// ── 2. 选豆包模型 ─────────────────────────────────────────
step(2, `选择模型「${MODEL_LABEL}」`);
await node.locator(".modelSelect").click();
await page.waitForTimeout(1200);
await page.locator(".el-select-dropdown__item", { hasText: MODEL_LABEL }).last().click();
await page.waitForTimeout(1200);
const settings = await node.evaluate((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
const settingsLine = (settings.match(/\d+:\d+ · [^·]+ · \d+秒/) || ["（未识别）"])[0];
console.log("   ✓ 已选中，节点参数显示：", settingsLine, /720p/.test(settingsLine) ? "← 补全的 720p 生效" : "← ⚠ 未用上补全的参数");

// ── 3. 填提示词 ───────────────────────────────────────────
step(3, "填写提示词");
// promptInput 是富文本组件，真正的输入区是 .chat-rich-text 里的 contenteditable。
// 直接对它 fill() 才会触发 Vue 的 v-model 更新（先前用 keyboard.type 写不进去）。
const editor = node.locator(".chat-rich-text [contenteditable]").first();
await editor.waitFor({ timeout: 10000 });
await editor.click();
await page.waitForTimeout(300);
await editor.fill(PROMPT);
await page.waitForTimeout(1000);
const typed = await node.evaluate((el) => (el.textContent || "").includes("一只橘猫"));
console.log("   ✓ 已输入", PROMPT.length, "字｜节点已同步:", typed ? "✓ 是" : "✗ 否（v-model 未更新）");
if (!typed) {
  await editor.pressSequentially(PROMPT, { delay: 15 });
  await page.waitForTimeout(1000);
  const retry = await node.evaluate((el) => (el.textContent || "").includes("一只橘猫"));
  console.log("   改用逐字输入后同步:", retry ? "✓ 是" : "✗ 否");
}

// ── 4. 点生成 ─────────────────────────────────────────────
step(4, "点击生成按钮");
const send = node.locator(".sendButton").last();
await send.waitFor({ timeout: 10000 });
await page.waitForTimeout(500);

const btnState = await send.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { disabled: el.disabled ?? el.classList.contains("is-disabled"), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
});
console.log("   按钮状态 :", JSON.stringify(btnState));

let submitted = false;
page.on("request", (r) => { if (r.url().includes("/api/ai/media/generate")) submitted = true; });

await send.click();
await page.waitForTimeout(2500);
if (!submitted) {
  console.log("   普通点击未触发，改用事件派发重试");
  await send.dispatchEvent("click");
  await page.waitForTimeout(2500);
}
if (!submitted) {
  console.log("   事件派发仍未触发，改为点击按钮中心坐标");
  await page.mouse.click(btnState.x + btnState.w / 2, btnState.y + btnState.h / 2);
  await page.waitForTimeout(2500);
}
console.log("   请求已发出 :", submitted ? "✓ 是" : "✗ 否");
console.log("   提交完成，等待豆包出片（约 2～4 分钟）…");

// ── 5. 轮询直到节点里出现成片 ─────────────────────────────
step(5, "轮询节点状态");
const startedAt = Date.now();
let done = false;
let lastNote = "";
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(15000);
  const state = await node.evaluate((el) => ({
    video: el.querySelectorAll("video").length,
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    spinning: !!el.querySelector(".is-loading, [class*=loading]"),
  }));
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const note = state.video ? "已出片" : state.spinning ? "生成中" : "等待中";
  if (note !== lastNote || secs % 60 < 15) console.log(`   ${secs}s｜video=${state.video}｜${note}｜${state.text.slice(0, 70)}`);
  lastNote = note;

  await page.screenshot({ path: `${SHOT_DIR}/node-gen-${secs}s.png` });
  if (state.video > 0) {
    // 等播放器把真实地址挂上
    await page.waitForTimeout(6000);
    const srcs = await node.evaluate((el) => [...el.querySelectorAll("video")].map((v) => v.currentSrc || v.src || "(空)"));
    console.log("   成片地址 :", srcs.join(" | ").slice(0, 200));
    done = true;
    break;
  }
}

console.log("\n=== 结论 ===");
console.log("  节点内出片 :", done ? "✓ 是" : "✗ 否（超时）");
console.log("  总耗时     :", Math.round((Date.now() - startedAt) / 1000), "秒");
console.log("  运行时错误 :", errs.length ? errs.slice(0, 3) : "无");

await page.screenshot({ path: `${SHOT_DIR}/node-gen-final.png`, fullPage: false });
await writeFile(
  `${SHOT_DIR}/node-gen-result.json`,
  JSON.stringify({ model: MODEL_LABEL, prompt: PROMPT, settingsLine, done, seconds: Math.round((Date.now() - startedAt) / 1000), errs }, null, 2),
  "utf-8",
);
await browser.close();
