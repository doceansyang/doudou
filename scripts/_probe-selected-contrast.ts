/**
 * 「设置 → 添加供应商」弹窗里，左侧厂商列表**选中项的对比度**实测。
 *
 * 用户报的问题：选中项的底色与文字都贴着深色面板（选中变黑、字看不见）。
 * 这里逐个点一遍，把「底 / 字 / 明暗差」打出来 —— 用数据判断，不靠看截图。
 *
 * 跑法：cd toonflow && bun scripts/_probe-selected-contrast.ts
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

/** 相对亮度（WCAG） */
const CONTRAST = `function contrast(fg, bg) {
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}`;

const READ = `(() => {
  ${CONTRAST}
  const parse = (v) => {
    const s = String(v || "");
    if (!s || s === "transparent") return null;
    // 兼容 rgb()/rgba() 与现代的 color(srgb r g b / a)（color-mix 派生出来的就是后者）
    const body = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
    const nums = body.split(/[,\\s/]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length < 3) return null;
    const scale = s.includes("srgb") && !s.startsWith("rgb") ? 255 : 1;
    return [nums[0] * scale, nums[1] * scale, nums[2] * scale];
  };
  const items = [...document.querySelectorAll(".providerSidebar .providerItem")];
  // 弹窗/面板的底色：沿 DOM 链找第一个不透明的背景
  const panelBg = (() => {
    let n = document.querySelector(".providerPicker") || document.querySelector(".el-dialog");
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      const cs = getComputedStyle(n);
      if (c && cs.backgroundColor !== "rgba(0, 0, 0, 0)") return c;
      n = n.parentElement;
    }
    return [20, 20, 20];
  })();
  return items.map((el) => {
    const cs = getComputedStyle(el);
    const bg = parse(cs.backgroundColor);
    const fg = parse(cs.color);
    const pressed = el.getAttribute("aria-pressed") === "true";
    // 选中项的底色若为全透明，就用面板底色作为实际底
    const realBg = bg && cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? bg : panelBg;
    return {
      text: (el.textContent || "").trim().slice(0, 14),
      pressed,
      bg: realBg,
      fg,
      contrast: fg ? Math.round(contrast(fg, realBg) * 100) / 100 : null,
    };
  });
})()`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(4000);

  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(1800);

  await page.locator(".providerActions .addButton").first().click();
  await page.waitForSelector(".providerSidebar .providerItem", { timeout: 15000 });
  await page.waitForTimeout(1500);

  log("=== 「添加供应商」左侧厂商列表：逐个点选后的配色 ===");
  log("");

  const n = await page.locator(".providerSidebar .providerItem").count();
  const rows: Array<{ text: string; pressed: boolean; contrast: number | null; bg: number[]; fg: number[] }> = [];
  for (let i = 0; i < n; i++) {
    await page.locator(".providerSidebar .providerItem").nth(i).click();
    await page.waitForTimeout(400);
    const list = (await page.evaluate(READ)) as Array<{ text: string; pressed: boolean; contrast: number | null; bg: number[]; fg: number[] }>;
    const sel = list.find((r) => r.pressed);
    if (sel) rows.push(sel);
  }

  for (const r of rows) {
    const flag = r.contrast === null ? "?" : r.contrast >= 4.5 ? "OK" : r.contrast >= 3 ? "偏低" : "不合格";
    log(`  「${r.text}」  底=${JSON.stringify(r.bg)}  字=${JSON.stringify(r.fg)}  对比=${r.contrast}:1  ${flag}`);
  }
  log("");
  const worst = rows.reduce((a, b) => ((a.contrast ?? 99) < (b.contrast ?? 99) ? a : b), rows[0]!);
  log(`最低 ${worst.contrast}:1（「${worst.text}」）→ ${(worst.contrast ?? 0) >= 4.5 ? "全部达标" : "仍有不达标"}`);

  await page.screenshot({ path: "assets/_selected-item.png" });
  log("截图：assets/_selected-item.png");
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_selected-contrast.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
