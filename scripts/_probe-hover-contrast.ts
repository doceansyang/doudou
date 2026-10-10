/**
 * 悬停/选中态对比度扫描：找出「鼠标一放上去就变成黑块」的元素。
 *
 * 为什么需要它：
 *   `_probe-low-contrast.ts` 只测**静态**渲染的文字对比度；
 *   而本项目最常踩的坑是**交互态**——EP 用主色表达 hover/选中，
 *   主色近黑（#171717）时文字与底色撞成一片，静态扫描查不出来。
 *
 * 跑法：cd toonflow && bun scripts/_probe-hover-contrast.ts
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

// 逐个面板、逐个可交互元素：悬停后测「文字 vs 有效背景」的明暗差
const MEASURE = `(node) => {
  const parse = (v) => {
    if (!v) return null;
    let m = String(v).match(/^rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(",").map(Number);
      if (p.length > 3 && p[3] === 0) return null;
      return p.slice(0, 3);
    }
    m = String(v).match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
    if (m) return [m[1], m[2], m[3]].map((n) => Math.round(Number(n) * 255));
    return null;
  };
  const lum = (p) => p ? 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] : null;
  const cs = getComputedStyle(node);
  let bg = parse(cs.backgroundColor);
  if (!bg) {
    let cur = node.parentElement;
    while (cur && cur !== document.documentElement) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c) { bg = c; break; }
      cur = cur.parentElement;
    }
  }
  const fg = parse(cs.color);
  const fl = lum(fg), bl = lum(bg);
  return {
    text: (node.textContent || "").trim().slice(0, 18),
    cls: String(node.className || node.tagName).slice(0, 56),
    fg: cs.color,
    bg: bg ? "rgb(" + bg.join(",") + ")" : "(未知)",
    diff: fl !== null && bl !== null ? +Math.abs(fl - bl).toFixed(0) : null,
  };
}`;

const SELECTOR = [
  "button",
  '[role="button"]',
  ".el-check-tag",
  ".el-radio",
  ".el-checkbox",
  ".el-select__wrapper",
  ".el-tag",
  "[aria-pressed]",
  ".el-segmented__item",
].join(",");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

/** 在当前画面上把每个可交互元素悬停一遍，返回低对比度的那些。 */
async function scan(label: string) {
  const nodes = page.locator(SELECTOR);
  const total = Math.min(await nodes.count(), 70);
  const hits: string[] = [];
  for (let i = 0; i < total; i++) {
    const node = nodes.nth(i);
    if (!(await node.isVisible().catch(() => false))) continue;
    await node.hover({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(80);
    const info = await node.evaluate(MEASURE).catch(() => null);
    if (info && info.diff !== null && info.diff < 45) {
      hits.push(`【${label}】「${info.text}」 明暗差=${info.diff}  字=${info.fg}  底=${info.bg}  来源=${info.cls}`);
    }
  }
  log(`  ${label}: 悬停态低对比度 ${hits.length} 处（检查 ${total} 个元素）`);
  return hits;
}

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(4000);

  const bad: string[] = [];

  // ① 工作区（画布 + 右侧助手面板）
  bad.push(...(await scan("工作区")));

  // ② 文档视图
  for (const selector of ['.el-segmented__item:has-text("文档")', 'div:has-text("文档")']) {
    try {
      await page.locator(selector).first().click({ timeout: 3000 });
      await page.waitForTimeout(3000);
      break;
    } catch { /* 换下一个选择器 */ }
  }
  bad.push(...(await scan("文档视图")));

  // ③ 首页
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  bad.push(...(await scan("首页")));

  // ④ 设置（回到工作区打开弹窗）
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1200);

  const panelNames = ["界面设置", "常规配置", "文本模型", "媒体模型", "插件市场", "MCP", "个性化", "隐私", "开发者选项", "关于"];
  for (const name of panelNames) {
    const item = page.locator(".settingsItem").filter({ hasText: name }).first();
    if (!(await item.count())) continue;
    await item.click().catch(() => {});
    await page.waitForTimeout(1100);
    bad.push(...(await scan(`设置·${name}`)));
  }

  log("");
  log("=== 明细 ===");
  if (!bad.length) log("（无）");
  bad.slice(0, 40).forEach((t) => log("  · " + t));
  log("");
  log(`合计: ${bad.length} 处`);
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_hover-contrast.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
