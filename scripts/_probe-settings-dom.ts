/**
 * 检查设置面板里「同一个 class、显示却不同」的元素（例如某个按钮渲染成黑块）。
 * 打开 设置 → 文本模型，把 .providerActions 区域整棵子树打印出来（盒子 + 计算样式）。
 *
 * 跑法：cd toonflow && bun scripts/_probe-settings-dom.ts
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

const DUMP = `(() => {
  const rgb = (v) => {
    const m = String(v || "").match(/^rgba?\\(([^)]+)\\)/);
    if (!m) return String(v || "");
    const p = m[1].split(",").map(Number);
    return p.slice(0, 3).join(",") + (p.length > 3 && p[3] < 1 ? " a=" + p[3] : "");
  };
  const lum = (s) => {
    const p = s.split(",").slice(0, 3).map(Number);
    return p.length === 3 && p.every((n) => !Number.isNaN(n))
      ? String(Math.round(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])) : "?";
  };
  const root = document.querySelector(".providerActions") || document.querySelector(".providerList");
  if (!root) return "（未找到 .providerActions / .providerList）";
  const out = [];
  const walk = (el, depth) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bg = rgb(cs.backgroundColor);
    out.push(
      "  ".repeat(depth)
      + el.tagName.toLowerCase()
      + (el.className ? "." + String(el.className).trim().split(/\\s+/).slice(0, 3).join(".") : "")
      + "  " + Math.round(r.width) + "x" + Math.round(r.height)
      + "  bg=" + bg + " (L" + lum(bg) + ")"
      + "  fg=" + rgb(cs.color)
      + "  op=" + cs.opacity
      + "  vis=" + cs.visibility
      + (el.tagName === "BUTTON" ? "  [button]" : "")
    );
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out.join("\\n");
})()`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(4000);

  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1200);

  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(2000);

  log("=== .providerActions 子树 ===");
  log(String(await page.evaluate(DUMP)));

  // 逐个按钮试「悬停 / 聚焦 / 按下」三态：EP 用主色浅调做底、主色做字，
  // 主色近黑时这几种状态会变成「黑底黑字」——用户看到的「选中变黑」多半就是它。
  log("");
  log("=== 各状态下的按钮配色（重点看 diff）===");
  const buttons = page.locator(".providerActions .addButton");
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const label = (await btn.innerText().catch(() => "")).trim() || `按钮${i}`;
    for (const state of ["默认", "hover", "focus"] as const) {
      if (state === "默认") await page.mouse.move(5, 5);
      if (state === "hover") await btn.hover();
      if (state === "focus") await btn.focus();
      await page.waitForTimeout(450);
      const info = await btn.evaluate((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        const lum = (v: string) => {
          const m = String(v).match(/^rgba?\(([^)]+)\)/);
          if (!m) return "?";
          const p = m[1].split(",").map(Number);
          return String(Math.round(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]));
        };
        return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderColor, diff: Math.abs(+lum(cs.backgroundColor) - +lum(cs.color)) };
      });
      log(`  ${label} [${state}]  bg=${info.bg}  fg=${info.fg}  明暗差=${info.diff}`);
    }
  }

  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);

  await page.screenshot({ path: "assets/_settings-dom.png" });
  log("");
  log("截图：assets/_settings-dom.png");
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_settings-dom.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
