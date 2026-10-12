// 探针：插件市场「发现插件」页签的**已安装判定**验收。
//
// 起因：市场卡片的 installLabel 原本只用 `${type}:${identifier}` 去已安装表里找，
// 而技能自报的名字（包里 SKILL.md 的 name）常常和市场的 identifier 不是一个东西
// （`foodAestheticShortFilm` vs `food-aesthetic-short-film`），于是装好了仍显示「安装」。
// 现在安装时会落下 `.toonflowMarket.json` 记来源，前端多了一张"按来源"的表兜住。
//
// 判据：市场全部卡片里，本机已装的插件**要么显示「已安装」文本、要么按钮是「更新」**，
//       没有任何一张仍然显示「安装」按钮（装过的那 4 个技能必须全部认出来）。
//
// ⚠️ 只读：不发安装请求、不改任何设置。
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
await page.waitForTimeout(4000);

const panel = page.locator(".pluginMarket").first();
await panel.waitFor({ state: "visible", timeout: 20000 });

const snapshot = await page.evaluate(() => {
  const panel = document.querySelector(".pluginMarket");
  if (!panel) return null;
  return [...panel.querySelectorAll(".pluginCard")].map((card) => {
    const button = card.querySelector(".pluginFooter .el-button");
    const footText = card.querySelector(".pluginFooter")?.textContent?.trim() ?? "";
    return {
      title: card.querySelector(".pluginTitle")?.textContent?.trim() ?? "",
      id: card.querySelector(".pluginId")?.textContent?.trim() ?? "",
      type: card.querySelector(".el-tag")?.textContent?.trim() ?? "",
      button: button?.textContent?.trim() ?? "",
      footText,
      showsInstalled: /已安装/.test(footText),
      showsUpdate: /更新/.test(footText),
      showsInstall: /安装/.test(button ?? ""),
    };
  });
});
if (!snapshot) throw new Error("插件市场面板没渲染出来");
await page.screenshot({ path: join(outDir, "plugin-market-installed-state.png"), fullPage: false });

console.log(`「发现插件」共 ${snapshot.length} 张卡片：`);
for (const card of snapshot) {
  const state = card.showsInstalled ? "已安装" : card.showsUpdate ? "可更新" : card.showsInstall ? "【仍显示安装】" : "其它";
  console.log(`  ${state.padEnd(12)} [${card.type}] ${card.title}（${card.id}）  按钮=${card.button || "-"}`);
}

let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `　${detail}` : ""}`);
  if (!pass) failures += 1;
};

// 本机装了 8 个市场插件里的全部（3 节点/工具 + 4 技能 + 1 工具），所以不该有任何一张还显示「安装」
const stillInstall = snapshot.filter((card) => card.showsInstall);
const recognized = snapshot.filter((card) => card.showsInstalled || card.showsUpdate);

check("① 列表真的加载出来了（不是靠报错空过）", snapshot.length > 0, `${snapshot.length} 张卡片`);
check("② 没有任何卡片仍显示「安装」按钮", stillInstall.length === 0,
      stillInstall.length ? JSON.stringify(stillInstall.map((c) => c.id)) : "零命中");
check("③ 全部卡片都判定为已安装/可更新", recognized.length === snapshot.length, `${recognized.length}/${snapshot.length}`);
check("④ 页面无脚本错误", errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : "无");

console.log(`\n截图：${join(outDir, "plugin-market-installed-state.png")}`);
console.log(failures ? `${failures} 条未通过` : "全部通过");
await browser.close();
process.exit(failures ? 1 : 0);
