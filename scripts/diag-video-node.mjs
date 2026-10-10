/**
 * 验证：Toonflow 画布「视频生成节点」能否选到豆包账号模型。
 *
 * 这是用户要的「节点级无缝对接」——不是 API 层能通就算完，
 * 而是要在画布上拖出视频生成节点、在节点的模型下拉里看到豆包并可选。
 *
 * 用法：bun run scripts/diag-video-node.mjs
 */
const { chromium } = await import("playwright");

const SHOT_DIR = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/assets/doubao-inspect";
await (await import("node:fs/promises")).mkdir(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1760, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text().slice(0, 200)); });

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "load", timeout: 40000 });
await page.locator(".vue-flow__pane").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(5000);
console.log("画布已就绪");

// ── 1. 双击空白，呼出节点菜单 ──────────────────────────────
const pane = await page.locator(".vue-flow__pane").first().boundingBox();
const px = pane.x + pane.width * 0.5;
const py = pane.y + pane.height * 0.55;
await page.mouse.dblclick(px, py);
await page.waitForTimeout(1600);

const menu = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".el-dropdown-menu__item")]
    .filter((el) => el.getBoundingClientRect().height > 8);
  return items.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
});
console.log("\n=== 节点菜单 ===");
console.log("  菜单项 :", JSON.stringify(menu));

// ── 2. 点「视频生成」节点 ─────────────────────────────────
let clicked = "";
for (const keyword of ["视频生成", "生成视频"]) {
  const item = page.locator(".el-dropdown-menu__item", { hasText: keyword }).first();
  if (await item.count()) {
    await item.click();
    clicked = keyword;
    break;
  }
}
console.log("  已点击 :", clicked || "（没找到视频生成项）");
await page.waitForTimeout(5000);

// ── 3. 检查节点是否渲染出来 ───────────────────────────────
const nodeInfo = await page.evaluate(() =>
  [...document.querySelectorAll(".vue-flow__node")].map((el) => ({
    type: String(el.className).replace("vue-flow__node", "").trim().slice(0, 40),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
  }))
);
console.log("\n=== 画布上的节点 ===");
nodeInfo.forEach((n) => console.log(`  [${n.type}] ${n.size}  ${n.text}`));

// ── 4. 打开节点里的模型下拉，看有没有豆包 ─────────────────
let options = [];
const selects = page.locator(".vue-flow__node .el-select");
const selectCount = await selects.count();
console.log("\n=== 模型下拉 ===");
console.log("  节点内下拉数量 :", selectCount);
if (selectCount) {
  await selects.last().click();
  await page.waitForTimeout(1500);
  options = await page.evaluate(() =>
    [...document.querySelectorAll(".el-select-dropdown__item")]
      .filter((el) => el.getBoundingClientRect().height > 8)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
  );
  console.log("  选项数量       :", options.length);
  options.forEach((o) => console.log("   -", o));
  await page.keyboard.press("Escape");
}

const hasDoubao = options.some((o) => /豆包|doubao/i.test(o));
console.log("\n=== 结论 ===");
console.log("  模型下拉含豆包 :", hasDoubao ? "✓ 是" : "✗ 否");
console.log("  运行时错误     :", errs.length ? errs.slice(0, 4) : "无");

await page.screenshot({ path: `${SHOT_DIR}/video-node.png` });
await browser.close();
