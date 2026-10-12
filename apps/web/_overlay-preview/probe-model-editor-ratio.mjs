// 验证「设置 → 媒体模型 → 编辑模型」里，视频模型多了一个可编辑的「画面比例」，
// 且值就是供应商文件里声明的那一组（节点上的比例选项就来自它）。
import { chromium } from "playwright";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text()); });

for (let attempt = 1; ; attempt++) {
  try { await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "load", timeout: 30000 }); break; }
  catch (e) { if (attempt >= 6) throw e; await page.waitForTimeout(3000); }
}
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
if (await entry.count()) await entry.click().catch(() => {});
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(2500);

// 打开设置 → 媒体模型
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1000);
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
if (!nav) { console.log("!! 设置里没找到「媒体模型」"); await browser.close(); process.exit(2); }
await page.mouse.click(nav.x, nav.y);
await page.locator(".providerList .providerItem").first().waitFor({ state: "visible", timeout: 25000 });
await page.waitForTimeout(1200);

// 找到 Linke 这张卡，点它的「编辑模型」
const cards = page.locator(".providerList .providerItem");
const count = await cards.count();
let linkeIndex = -1;
for (let i = 0; i < count; i++) {
  const t = (await cards.nth(i).innerText()).replace(/\s+/g, " ");
  if (/Linke/.test(t)) { linkeIndex = i; break; }
}
console.log("Linke 卡片索引:", linkeIndex);
const linkeCard = cards.nth(linkeIndex);
console.log("卡片文案:", (await linkeCard.innerText()).replace(/\s+/g, " ").slice(0, 120));
await linkeCard.getByText("编辑模型").first().click();
await page.waitForTimeout(1500);

// 找到 Seedance 2.0 那一行的「编辑」
const editBtn = page.locator('[aria-label="编辑模型 Seedance 2.0"]').first();
if (!(await editBtn.count())) {
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll("[aria-label^='编辑模型']")).map((e) => e.getAttribute("aria-label")));
  console.log("!! 没找到「编辑模型 Seedance 2.0」，现有：", JSON.stringify(labels));
  await page.screenshot({ path: join(outDir, "_model-editor-ratio-fail.png") });
  await browser.close();
  process.exit(2);
}
await editBtn.click();
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  // ⚠️ `aria-label` 落在 el-input-tag 的**内部 input** 上，不是外层容器 ——
  //    所以 `[aria-label="视频画面比例"] .el-tag` 永远匹配不到（实测取到空数组）。
  //    标签在同级的 .ratioEditor 里，直接找它。
  const wrap = document.querySelector(".ratioEditor");
  const ratios = wrap
    ? Array.from(wrap.querySelectorAll(".el-tag")).map((t) => (t.textContent ?? "").replace(/[×✕\s]/g, "")).filter(Boolean)
    : [];
  return {
    ratios,
    hint: wrap?.querySelector(".fieldHint")?.textContent?.trim() ?? null,
    hasField: !!document.querySelector('[aria-label="视频画面比例"]'),
    labelText: wrap?.closest(".el-form-item")?.querySelector(".el-form-item__label")?.textContent?.trim() ?? null,
  };
});
console.log("\n=== 视频模型编辑器 ===");
console.log("  「画面比例」字段存在 =", info.hasField ? "✅" : "✗");
console.log("  表单项标题 =", info.labelText);
console.log("  字段里的比例 =", JSON.stringify(info.ratios));
console.log("  提示文案 =", info.hint);
const expect = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const ok = expect.every((r) => info.ratios.includes(r));
console.log("  与供应商文件声明一致 =", ok ? "✅" : "✗ 期望含 " + expect.join("/"));

await page.screenshot({ path: join(outDir, "_model-editor-ratio.png") });
console.log("\n页面错误:", errors.length ? errors.join(" | ") : "（无）");
await browser.close();
