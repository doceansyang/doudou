/**
 * 深色模式对比度验证（结果写文件，避免被 tail 截断）。
 *
 * 关键点：
 *   · 用 page.mouse.move() 真实触发 :hover（比 elementHandle.hover() 快，不会等可操作性超时）
 *   · 右键点画布**空白处**才会出「上传/添加节点/撤销/重做/从剪贴板粘贴」那个操作菜单
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const lum = (value: string): number | null => {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1]!.split(",").map((s) => Number.parseFloat(s) / 255);
  return 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
};
const verdict = (bg: string, fg: string) => {
  const b = lum(bg), f = lum(fg);
  if (b === null || f === null) return "?";
  const d = Math.abs(b - f);
  return `亮度差 ${d.toFixed(3)}  ${d < 0.15 ? "❌ 糊在一起" : "✓ 可读"}`;
};

const out: string[] = [];
const log = (s: string) => out.push(s);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000);

log("主题变量: " + await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return `dark=${document.documentElement.classList.contains("dark")}  primary=${cs.getPropertyValue("--el-color-primary").trim()}  brandFg=${cs.getPropertyValue("--ui-brand-foreground").trim()}`;
}));

log("\n① 面板切换器（画布 / 文档）");
const seg = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".el-segmented__item")).map((el) => {
    const cs = getComputedStyle(el);
    return { text: (el as HTMLElement).innerText.trim(), selected: el.classList.contains("is-selected"), bg: cs.backgroundColor, fg: cs.color };
  })
);
for (const s of seg) log(`   ${s.selected ? "[选中]" : "[普通]"} ${s.text}    底=${s.bg}   字=${s.fg}   ${verdict(s.bg, s.fg)}`);

log("\n② 画布空白处右键菜单");
await page.mouse.click(1000, 780, { button: "right" });
await page.waitForTimeout(1500);
const boxes = await page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>(".el-dropdown-menu__item")).map((el, i) => {
    const r = el.getBoundingClientRect();
    return { i, text: el.innerText.trim().slice(0, 12), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })
);
if (!boxes.length) {
  log("   （菜单未打开）");
} else {
  for (const b of boxes) {
    await page.mouse.move(b.x, b.y);
    await page.waitForTimeout(180);
    const style = await page.evaluate((index) => {
      const el = document.querySelectorAll<HTMLElement>(".el-dropdown-menu__item")[index]!;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, hovered: el.matches(":hover") };
    }, b.i);
    log(`   ${style.hovered ? "[悬停]" : "[普通]"} ${b.text.padEnd(12)} 底=${style.bg}   字=${style.fg}   ${verdict(style.bg, style.fg)}`);
  }
}

await page.screenshot({ path: "assets/_dark-contrast.png" });
log("\n截图: toonflow/assets/_dark-contrast.png");

writeFileSync("assets/_dark-contrast.txt", out.join("\n"), "utf-8");
console.log(out.join("\n"));

await browser.close();
