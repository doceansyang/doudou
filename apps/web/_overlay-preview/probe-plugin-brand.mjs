import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：插件市场的**品牌泄漏**验收。
//
// 起因：上游有几个插件把自家品牌写进了 identifier（`toonflowLuxuryPawnRecoveryComicDrama`），
// 市场卡片那行小字原本直接渲染 identifier，用户一眼就看见 "toonflow"。
// 现在显示层会摘掉 `toonflow` 前缀（**只动显示，identifier 本身保持原样**，否则装不上）。
//
// 判据：
//   ① 插件市场面板的**可见文本里一个 "toonflow" 都没有**（忽略大小写）
//   ② 那张卡片的 ID 小字确实变成了去前缀的形式（且不是空的 / 不是被判成"已安装"）
//   ③ 面板能正常列出插件（不是"因为加载失败所以没文字"的假通过）
//   ④ 页面无脚本错误
//
// ⚠️ 本探针**只读不写**设置（历史教训：写设置的探针曾把用户真填的 key 删掉）。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });

await page.locator('button[aria-label="设置"]').first().waitFor({ state: "visible", timeout: 20000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);

// 点左侧「插件市场」导航项（按文本+可见性定位，取最深的一个）。
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
await page.waitForTimeout(3500);

const panel = page.locator(".pluginMarket").first();
await panel.waitFor({ state: "visible", timeout: 20000 });

const snapshot = await page.evaluate(() => {
  const panel = document.querySelector(".pluginMarket");
  if (!panel) return null;
  const visibleText = (root) => {
    const out = [];
    root.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = (n.textContent || "").trim();
          if (t) out.push(t);
        }
      });
    });
    return out;
  };
  return {
    text: visibleText(panel),
    cards: [...panel.querySelectorAll(".pluginCard")].map((card) => ({
      title: card.querySelector(".pluginTitle")?.textContent?.trim() ?? "",
      id: card.querySelector(".pluginId")?.textContent?.trim() ?? "",
    })),
  };
});

if (!snapshot) throw new Error("插件市场面板没渲染出来");
await page.screenshot({ path: join(outDir, "plugin-market-brand.png"), fullPage: false });

// 「已安装」页签也要扫 —— 那里的名字/描述来自**本地扫描**（插件自己的 SKILL.md / 节点元数据），
// 是另一个可能露出品牌的地方。
await page.locator(".navButton", { hasText: "已安装" }).first().click();
await page.waitForTimeout(2500);
const installedSnapshot = await page.evaluate(() => {
  const panel = document.querySelector(".pluginMarket");
  if (!panel) return null;
  const out = [];
  panel.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = (n.textContent || "").trim();
        if (t) out.push(t);
      }
    });
  });
  return {
    text: out,
    cards: [...panel.querySelectorAll(".pluginCard")].length,
  };
});
await page.screenshot({ path: join(outDir, "plugin-market-installed.png"), fullPage: false });

const hits = snapshot.text.filter((t) => /toonflow/i.test(t));
const installedHits = (installedSnapshot?.text || []).filter((t) => /toonflow/i.test(t));

console.log(`「发现插件」可见文本片段 ${snapshot.text.length} 个 / 卡片 ${snapshot.cards.length} 张`);
for (const c of snapshot.cards) console.log(`  - ${c.title}　|　${c.id}`);
console.log(`「已安装」可见文本片段 ${(installedSnapshot?.text || []).length} 个 / 卡片 ${installedSnapshot?.cards ?? 0} 张`);
console.log(`\n命中 toonflow：发现页签 ${hits.length} 处，已安装页签 ${installedHits.length} 处\n`);

let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `　${detail}` : ""}`);
  if (!pass) failures += 1;
};

const target = snapshot.cards.find((c) => c.title.includes("典当") || c.title.includes("回收")) ?? snapshot.cards[0];
check("① 面板可见文本里没有 toonflow", hits.length === 0, hits.length ? JSON.stringify(hits.slice(0, 4)) : "零命中");
check("② 插件列表真的加载出来了（不是靠报错空过）", snapshot.cards.length > 0, `${snapshot.cards.length} 张卡片`);
check("③ 卡片 ID 小字已去前缀", snapshot.cards.every((c) => !/toonflow/i.test(c.id)), target ? `例：${target.id}` : "");
check("④ 页面无脚本错误", errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : "无");
check("⑤ 「已安装」页签也没有 toonflow", installedHits.length === 0,
      installedHits.length ? JSON.stringify(installedHits.slice(0, 4)) : "零命中");
check("⑥ 「已安装」页签确实有内容（不是空过）", (installedSnapshot?.cards ?? 0) > 0, `${installedSnapshot?.cards ?? 0} 张卡片`);

console.log(`\n截图：scripts/_out/plugin-market-brand.png`);
console.log(failures ? `${failures} 条未通过` : "全部通过");
await browser.close();
process.exit(failures ? 1 : 0);
