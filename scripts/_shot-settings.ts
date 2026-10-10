/** 截一张「设置 → 文本模型」的效果图（对应反馈的那两个黑块位置）。 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
await page.waitForTimeout(5000);

await page.locator('button[title^="设置"]').first().click();
await page.waitForSelector(".settingsItem", { timeout: 15000 });
await page.waitForTimeout(1200);

await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "assets/_settings-fixed.png" });

// 顺便读一下之前那两个黑块现在的颜色
const info = await page.evaluate(() => {
  const parse = (v) => {
    const m = String(v).match(/^rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(",").map(Number); return p.slice(0, 3); }
    const s = String(v).match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (s) return [Number(s[1]), Number(s[2]), Number(s[3])].map((x) => Math.round(x * 255));
    return null;
  };
  const lum = (c) => c ? +(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toFixed(1) : null;
  const bgOf = (el) => {
    let cur = el;
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c) return c;
      cur = cur.parentElement;
    }
    return [20, 20, 20];
  };
  const out = {};
  const active = document.querySelector('.settingsItem[aria-pressed="true"]');
  if (active) {
    const cs = getComputedStyle(active);
    out.sidebarActive = { text: (active.textContent || "").trim(), color: cs.color, bg: cs.backgroundColor,
      diff: Math.abs(lum(parse(cs.color)) - lum(parse(cs.backgroundColor))) };
  }
  const tag = document.querySelector(".providerHeading .el-tag");
  if (tag) {
    const cs = getComputedStyle(tag);
    const bg = bgOf(tag);
    out.officialTag = { text: (tag.textContent || "").trim(), color: cs.color, bg: `rgb(${bg.join(",")})`,
      diff: Math.abs(lum(parse(cs.color)) - lum(bg)) };
  }
  return out;
});

console.log("侧栏选中项:", JSON.stringify(info.sidebarActive));
console.log("「官方」标签:", JSON.stringify(info.officialTag));
await browser.close();
