// 探针：插件市场切到自家中转（https://linke.link/v1/plugin/*）后的界面验收。
//
// 判据（四条，缺一不可）：
//  ① 市场列表真的加载出来了（卡片 > 0），不是靠报错空过
//  ② 客户端**不再要求填市场 key**：没有密钥输入框、没有"填写插件市场密钥"提示
//  ③ 真实网络请求里**一次都不出现 toonflow**（列表 + 下载全走我们的域名）
//  ④ 页面文本里也查不到 toonflow 字样
//
// ⚠️ 只读：不改设置、不装插件。
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// 抓全部出站请求，用来证伪"客户端还在碰 toonflow"
const requests = [];
page.on("request", (r) => requests.push(r.url()));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator('button[aria-label="设置"]').first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);

const nav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "插件市场") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
if (!nav) throw new Error("没找到「插件市场」导航项");
await page.mouse.click(nav.x, nav.y);
await page.waitForTimeout(5000);

const panel = page.locator(".pluginMarket").first();
await panel.waitFor({ state: "visible", timeout: 20000 });

const snapshot = await page.evaluate(() => {
  const panel = document.querySelector(".pluginMarket");
  if (!panel) return null;
  return {
    cards: [...panel.querySelectorAll(".pluginCard")].map((card) => ({
      title: card.querySelector(".pluginTitle")?.textContent?.trim() ?? "",
      button: card.querySelector(".pluginFooter .el-button")?.textContent?.trim() ?? "",
    })),
    hasKeyInput: !!panel.querySelector('input[aria-label="插件市场密钥"]'),
    keyPrompt: /填写插件市场密钥|插件市场登录已失效/.test(panel.textContent || ""),
    alertText: [...panel.querySelectorAll(".el-alert__title")].map((el) => el.textContent?.trim() ?? ""),
    textHasToonflow: /toonflow/i.test(panel.textContent || ""),
  };
});
if (!snapshot) throw new Error("插件市场面板没渲染出来");
await page.screenshot({ path: join(outDir, "plugin-market-linke.png"), fullPage: false });

const marketRequests = requests.filter((u) => u.includes("/v1/plugin/"));
const leakRequests = requests.filter((u) => /toonflow/i.test(u));

let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `　${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log(`市场卡片 ${snapshot.cards.length} 张；/v1/plugin/ 请求 ${marketRequests.length} 次`);
for (const url of marketRequests.slice(0, 4)) console.log("   →", url.slice(0, 100));

check("① 列表真的加载出来了", snapshot.cards.length > 0, `${snapshot.cards.length} 张卡片`);
check("② 不再要求填市场密钥", !snapshot.hasKeyInput && !snapshot.keyPrompt,
      snapshot.alertText.length ? `面板提示：${JSON.stringify(snapshot.alertText)}` : "无密钥输入框、无提示");
check("③ 网络请求里零 toonflow", leakRequests.length === 0,
      leakRequests.length ? JSON.stringify(leakRequests.slice(0, 3)) : `检查了 ${requests.length} 个请求`);
check("④ 页面文本里零 toonflow", !snapshot.textHasToonflow);
check("⑤ 市场请求确实走了 linke.link", marketRequests.some((u) => u.includes("linke.link")),
      marketRequests[0]?.slice(0, 60) ?? "没有任何市场请求");
check("⑥ 页面无脚本错误", errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : "无");

console.log(`\n截图：${join(outDir, "plugin-market-linke.png")}`);
console.log(failures ? `${failures} 条未通过` : "全部通过");
await browser.close();
process.exit(failures ? 1 : 0);
