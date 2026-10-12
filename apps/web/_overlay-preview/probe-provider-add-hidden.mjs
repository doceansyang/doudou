import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：设置 → 文本模型 / 媒体模型 里**底部那两个添加入口是否已经消失**。
//
// 为什么要有它：按钮是 `v-if` / 模板删除两种写法，光看构建成功判断不出"界面上还在不在"。
// 这里驱动真实 Web UI，按**可见文字**判定，并顺手确认「编辑 / 删除」这些原有入口没被误伤。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });

// ⚠️ 「设置」是纯图标按钮（只有 aria-label，没有文字）—— 用 hasText 找必然超时。
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);

/** 点左侧导航项：取「文本精确匹配里最深」的那个节点（最外层容器会点空）。 */
async function clickNav(text) {
  const hit = await page.evaluate((label) => {
    const cands = [];
    document.querySelectorAll("*").forEach((el) => {
      if ((el.textContent || "").trim() !== label) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      let depth = 0;
      for (let q = el; q; q = q.parentElement) depth += 1;
      cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    cands.sort((a, b) => b.depth - a.depth);
    return cands[0] || null;
  }, text);
  if (!hit) throw new Error(`设置面板里没找到导航项「${text}」`);
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(1200);
}

/** 面板内的可见文字统计（只取可见元素，避免命中隐藏/未挂载的模板）。 */
async function panelText() {
  return page.evaluate(() => {
    const shot = [];
    document.querySelectorAll("*").forEach((el) => {
      if (el.children.length) return;
      const t = (el.textContent || "").trim();
      if (!t) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      shot.push(t);
    });
    return shot;
  });
}

let failures = 0;
for (const [nav, shot] of [["文本模型", "settings-text-providers.png"], ["媒体模型", "settings-media-providers.png"]]) {
  await clickNav(nav);
  const texts = await panelText();
  const addEntries = texts.filter((t) => t.includes("添加供应商") || t.includes("添加自定义供应商"));
  const addButtons = await page.locator(".addButton").count();
  const cards = await page.locator(".providerItem").count();
  const actions = await page.locator(".itemActions button").allInnerTexts();
  const ok = addEntries.length === 0 && addButtons === 0 && cards > 0;
  if (!ok) failures += 1;
  console.log(`\n=== ${nav} ===`);
  console.log(`  供应商卡片数：${cards}`);
  console.log(`  卡片上的操作：${JSON.stringify(actions.map((t) => t.trim()))}`);
  console.log(`  命中「添加…供应商」的可见文字：${JSON.stringify(addEntries)}（应为空）`);
  console.log(`  .addButton 元素数：${addButtons}（应为 0）`);
  console.log(`  结论：${ok ? "✓ 两个入口已消失，且原有操作完好" : "✗ 仍有添加入口或面板未加载"}`);
  await page.screenshot({ path: join(outDir, shot), fullPage: false });
}

console.log(`\n页面错误：${errors.length ? JSON.stringify(errors.slice(0, 4)) : "无"}`);
await browser.close();
process.exit(failures ? 1 : 0);
