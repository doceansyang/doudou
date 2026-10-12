import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：从「设置里点的外链」离开软件、再回来时，设置面板能不能自动回到原来的页签。
//
// 这里模拟的是"同一个标签页导航到外部域再回来"：点外链（记标记）→ reload（等价于
// 回来时 SPA 重新启动）→ 看设置是否自动打开且停在原页签。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const KEY = "toonflow:settings-restore";
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// 点 target=_blank 会开新标签；这里只是不想留一个挂在登录页的窗口
page.on("popup", (p) => { void p.close().catch(() => {}); });

await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.waitForTimeout(2000);

const readFlag = () => page.evaluate((k) => {
  const raw = localStorage.getItem(k);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { parseError: raw.slice(0, 40) }; }
}, KEY);

console.log("=== 步骤 1：打开设置 → 文本模型 ===");
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(900);
const nav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "文本模型") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
await page.mouse.click(nav.x, nav.y);
await page.locator(".tfAccount").first().waitFor({ state: "visible", timeout: 20000 });
await page.waitForTimeout(1500);
console.log("  点击前标记:", await readFlag(), "（应为 null）");

console.log("=== 步骤 2：点设置里的外链「查看余额」===");
const link = page.locator('a[href*="api.linke.link"]').first();
console.log("  外链 href:", await link.getAttribute("href"));
// 拦掉真实的跳转（这里只关心"点击那一刻有没有记标记"），点击事件照常冒泡
await page.evaluate(() => {
  window.addEventListener("click", (e) => {
    const a = e.target?.closest?.("a[href]");
    if (a && /^https?:/i.test(a.getAttribute("href") || "")) e.preventDefault();
  }, true);
});
await link.click({ force: true });
await page.waitForTimeout(600);
const flag = await readFlag();
console.log("  点击后标记:", JSON.stringify(flag));
const wrote = !!flag && flag.panel === "languageModel";
console.log("  判定：", wrote ? "✅ 已在点击时刻记下页签" : "⚠️ 没记上/页签不对");

console.log("=== 步骤 3：模拟「返回软件」（重新加载 SPA）===");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const after = await page.evaluate(() => {
  const dialog = document.querySelector(".el-dialog");
  const visible = !!dialog && dialog.getBoundingClientRect().width > 0;
  const active = Array.from(document.querySelectorAll(".settingsItem"))
    .filter((el) => el.getAttribute("aria-pressed") === "true")
    .map((el) => (el.textContent || "").trim());
  return { dialogVisible: visible, activePanel: active[0] || null, url: location.href };
});
console.log("  重载后 URL:", after.url);
console.log("  设置弹窗已打开:", after.dialogVisible, " 当前页签:", after.activePanel);
console.log("  标记是否已消费:", (await readFlag()) === null, "（应为 true）");
const restored = after.dialogVisible && after.activePanel === "文本模型";
console.log("  判定：", restored ? "✅ 返回后自动回到「设置 → 文本模型」" : "⚠️ 没恢复");

if (after.dialogVisible) {
  await page.screenshot({ path: join(outDir, "_settings-return.png") });
}

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
