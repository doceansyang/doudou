// 验证首页品牌字的「渐变流动」动效：隔 2.5 秒各截一次品牌字，比对像素差异。
// 只截元素本身（不是整页），差异来源就只可能是这段动画。
//
// 用法：bun scripts/_probe-wordmark.ts  → 出 _out/wordmark-t0.png / wordmark-t1.png
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/scripts/_out";
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const executablePath = CANDIDATES.find(p => existsSync(p));
if (!executablePath) { console.log("✗ 找不到浏览器"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: false, args: ["--window-position=80,80"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  const wordmark = page.locator(".gradientWordmark").first();
  await wordmark.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".gradientWordmark");
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      text: el.textContent,
      backgroundImage: style.backgroundImage,
      backgroundSize: style.backgroundSize,
      animation: style.animationName + " " + style.animationDuration + " " + style.animationTimingFunction + " " + style.animationIterationCount + " " + style.animationDirection,
      color: style.color,
      backgroundClip: style.webkitBackgroundClip || style.backgroundClip,
    };
  });
  console.log("品牌字样式：" + JSON.stringify(info, null, 2));

  await wordmark.screenshot({ path: join(OUT, "wordmark-t0.png") });
  // 动画跑到一半再截一次
  await page.waitForTimeout(2500);
  await wordmark.screenshot({ path: join(OUT, "wordmark-t1.png") });
  console.log("已出图：wordmark-t0.png / wordmark-t1.png");
} catch (error) {
  console.log("✗ " + String(error).split("\n")[0]);
} finally {
  await browser.close();
}
