/**
 * 低对比度扫描：遍历设置里每个面板，找出「文字与背景明暗差过小」的元素。
 * 用途：一次找全「主色近黑导致深色模式下看不清/变黑块」的同类问题。
 * page.evaluate 内只写纯 JS。
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const VIEW = { width: 1600, height: 950 };
const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const SCAN = `(() => {
  const parseRgb = (value) => {
    if (!value) return null;
    let m = String(value).match(/^rgba?\\(([^)]+)\\)/);
    if (m) {
      const parts = m[1].split(",").map(Number);
      if (parts.length > 3 && parts[3] === 0) return null;   // 全透明
      return parts.slice(0, 3);
    }
    m = String(value).match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v * 255));
    return null;
  };
  const lum = (rgb) => rgb ? +(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]).toFixed(1) : null;
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const rgb = parseRgb(getComputedStyle(cur).backgroundColor);
      if (rgb) return rgb;
      cur = cur.parentElement;
    }
    return parseRgb(getComputedStyle(document.body).backgroundColor) || [20, 20, 20];
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    if (!el) continue;
    const text = (node.textContent || "").trim();
    if (!text) continue;
    if (el.closest(".el-select-dropdown, .el-popper")) continue;   // 未展开的弹层跳过
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.15) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const fg = parseRgb(cs.color);
    const bg = bgOf(el);
    const fl = lum(fg), bl = lum(bg);
    if (fl === null || bl === null) continue;
    const diff = Math.abs(fl - bl);
    if (diff < 45) {
      out.push({
        text: text.slice(0, 20),
        diff: +diff.toFixed(1),
        color: cs.color,
        bg: "rgb(" + bg.join(",") + ")",
        cls: (el.className || el.tagName).toString().slice(0, 60),
      });
    }
  }
  // 去重（同文本同色）
  const seen = new Set();
  return out.filter((x) => {
    const k = x.text + x.color + x.cls;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})()`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 140)}`));

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  // 打开设置：工作区左上角那颗「设置」按钮（title 以"设置"开头），单击直接打开弹窗
  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1500);
  log(`设置弹窗已打开，左侧菜单项 ${await page.locator(".settingsItem").count()} 个`);

  const panelNames = ["界面设置", "常规配置", "文本模型", "媒体模型", "插件市场", "MCP", "个性化", "隐私", "开发者选项", "关于"];
  const all: Record<string, any[]> = {};
  for (const name of panelNames) {
    const item = page.locator(".settingsItem").filter({ hasText: name }).first();
    if (!(await item.count())) { log(`  （跳过 ${name}：未找到菜单项）`); continue; }
    await item.click().catch(() => {});
    await page.waitForTimeout(1400);
    const found = await page.evaluate(SCAN);
    all[name] = found;
    log(`  ${name}: ${found.length} 处低对比度`);
  }

  log("");
  log("=== 明细 ===");
  let total = 0;
  for (const [name, list] of Object.entries(all)) {
    if (!list.length) continue;
    log("");
    log(`【${name}】`);
    list.slice(0, 12).forEach((x) => {
      total += 1;
      log(`  · 「${x.text}」 明暗差=${x.diff}`);
      log(`      文字=${x.color}  背景=${x.bg}`);
      log(`      来源=${x.cls}`);
    });
  }
  log("");
  log(`合计低对比度元素: ${total} 处`);

  await page.screenshot({ path: "assets/_low-contrast.png" });
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_low-contrast.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
