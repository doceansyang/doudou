import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：设置 → 文本模型 里的「账户余额」区块。
//
// 验的是"填了 key 之后这块到底显示成什么样" —— 尤其别再把 axios 的
// "Request failed with status code 404" 原样抖给用户。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });

// 打开设置 → 文本模型
// ⚠️ 「设置」是**纯图标按钮**（`.el-button.is-text.toolButton`，只有 aria-label="设置"、
//    没有文字）—— 用 hasText 找必然超时。按 aria-label 定位。
const settingsBtn = page.locator('button[aria-label="设置"]').first();
await settingsBtn.click();
await page.waitForTimeout(1000);

// 选左侧导航的「文本模型」：取文本精确匹配里**最深**的那个节点
// （最外层容器往往整块都含这段文字，点它会点空）
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
console.log("  「文本模型」导航命中:", JSON.stringify(nav));
if (!nav) {
  console.log("  !! 设置面板里没找到「文本模型」");
  await page.screenshot({ path: join(outDir, "_tf-account-failed.png") });
  await browser.close();
  process.exit(2);
}
await page.mouse.click(nav.x, nav.y);

await page.locator(".tfAccount").first().waitFor({ state: "visible", timeout: 20000 });
await page.waitForTimeout(3000);   // 等余额请求跑完

const info = await page.evaluate(() => {
  const root = document.querySelector(".tfAccount");
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const has = (sel) => !!document.querySelector(sel);
  const btn = (label) => Array.from(root.querySelectorAll("button, a")).find((b) => (b.textContent || "").includes(label)) || null;
  const consoleLink = btn("网关控制台");
  return {
    balanceLabel: txt(".accountBalance .el-text"),
    balanceNumber: txt(".balanceNumber"),
    balanceHint: txt(".balanceHint"),
    errorText: txt(".accountError"),
    notice: txt(".accountNotice"),
    rechargeBtn: !!btn("充值"),
    consoleHref: consoleLink ? consoleLink.getAttribute("href") : null,
    raw404Shown: /404|status code/i.test(root.textContent || ""),
  };
});

console.log("=== 设置 → 文本模型 · 账户余额区块 ===");
console.log("  余额标题      :", info.balanceLabel);
console.log("  大号数字      :", info.balanceNumber);
console.log("  替代说明      :", info.balanceHint);
console.log("  红色报错      :", info.errorText);
console.log("  说明段        :", info.notice);
console.log("  充值按钮      :", info.rechargeBtn, "（网关无接口时应为 false）");
console.log("  控制台链接    :", info.consoleHref);
console.log("  页面是否出现 404 字样:", info.raw404Shown, "（应为 false）");
console.log("  判定:", !info.raw404Shown && !info.rechargeBtn && info.consoleHref
  ? "✅ 已降级为「网关未提供接口 + 控制台入口」"
  : "⚠️ 与预期不符");

const box = await page.locator(".tfAccount").first().boundingBox();
if (box) {
  await page.screenshot({
    path: join(outDir, "_tf-account.png"),
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  console.log("  截图: _tf-account.png");
}
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
