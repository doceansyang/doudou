/**
 * 引导页「稍后配置」高亮的实况验收。
 *
 * ⚠️ 为什么要把按钮单独截成小图交给 Python 读像素：
 * 我们的配色是 `color-mix(in srgb, …)` 算出来的，浏览器给的 computed value 是
 * `oklab()` / `color(srgb …)` 之类，正则解析不出来（第一次就栽在这 —— 三个字段全 null，
 * 判据还"全绿"了，纯属假阳性）。所以这里只负责**取实况像素**与原始字符串，判定交给
 * `scripts/_probe-hello-later-button.py`。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
await page.getByText("快速开始").waitFor({ state: "visible", timeout: 25000 });
await page.waitForTimeout(600);

const meta = await page.evaluate(() => {
  const pick = (text) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text) || null;
  const dump = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      classes: el.className,
      color: cs.color,
      borderColor: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      fontWeight: cs.fontWeight,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      // 「只改颜色不改样式」的验收对象：尺寸 / 字号 / 圆角必须与旁边的次要按钮逐项相同。
      geometry: {
        height: cs.height,
        width: cs.width,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        borderRadius: cs.borderRadius,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        boxSizing: cs.boxSizing,
      },
    };
  };
  const body = getComputedStyle(document.body).backgroundColor;
  return {
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    primary: getComputedStyle(document.documentElement).getPropertyValue("--el-color-primary").trim(),
    brand: getComputedStyle(document.documentElement).getPropertyValue("--ui-brand-foreground").trim(),
    body,
    later: dump(pick("稍后配置")),
    custom: dump(pick("添加私有提供商")),
    login: dump(pick("登录 Linke 自动配置")),
  };
});

console.log(`主题=${meta.theme}　主色=${meta.primary}　页面底色=${meta.body}`);
console.log(`品牌前景色=${meta.brand}\n`);
for (const [label, key] of [["稍后配置", "later"], ["添加私有提供商", "custom"], ["登录 Linke（主）", "login"]]) {
  const m = meta[key];
  console.log(`${label.padEnd(16, " ")} ${JSON.stringify(m)}`);
}

await page.locator("button", { hasText: "稍后配置" }).first().screenshot({ path: join(outDir, "_btn-later.png") });
await page.locator("button", { hasText: "添加私有提供商" }).first().screenshot({ path: join(outDir, "_btn-custom.png") });

// 悬停态单独取一次：`assets/main.scss` 有一条深色主题专用的
// `html.dark .el-button:not(.el-button--primary)…:hover`（特异性 0,8,1），
// scoped 选择器压不过它 —— 真压不过时，悬停会在紫渐变上冒灰边、白字变灰。
// 这里就是那条 `!important` 的验收。
const laterBtn = page.locator("button", { hasText: "稍后配置" }).first();
await laterBtn.hover();
await page.waitForTimeout(300);
const hovered = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "稍后配置");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { color: cs.color, borderColor: cs.borderTopColor, backgroundImage: cs.backgroundImage };
});
await page.mouse.move(20, 20);
await page.waitForTimeout(150);

// computed 颜色字符串与像素判定都交给 Python（`scripts/_probe-hello-later-button.py`）：
// 前者比字符串差异最可靠（`color-mix` 的 computed 形态打印出来就够比对），
// 后者才是"肉眼看到的样子"。
writeFileSync(
  join(outDir, "_hello-later-meta.json"),
  JSON.stringify({ ...meta, hovered, pageErrors: errors }, null, 2),
);

const box = await page.getByText("稍后配置").first().boundingBox();
await page.screenshot({
  path: join(outDir, "hello-later-button.png"),
  clip: { x: Math.max(0, box.x - 150), y: Math.max(0, box.y - 70), width: box.width + 280, height: box.height + 130 },
});
await page.screenshot({ path: join(outDir, "hello-later-full.png") });

console.log(`\n页面错误：${errors.length ? JSON.stringify(errors.slice(0, 2)) : "无"}`);
await browser.close();
