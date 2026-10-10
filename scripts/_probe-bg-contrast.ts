// 首页「文字 vs 背景」对比度采集：支持**半透明玻璃面**。
//
// 为什么要这么绕（踩过两次）：
//   直接对成图采样「文字 vs 其周围像素」永远会被**字形抗锯齿边缘**污染，
//   会算出 1.1:1 的假结论。所以：
//     ① 隐藏页头/正文，只截**纯背景图**（图里没有文字 → 采样干净）；
//     ② 记录每个文字元素的位置、颜色，**以及它到 .home 之间每一层的背景色与透明度**
//        （毛玻璃卡片是半透明的，不能简单当成"实心"或"透明"）。
//   Python 侧再把这几层按 alpha 合成，得到文字真正的有效底色。
//
// 用法：bun scripts/_probe-bg-contrast.ts   然后 python scripts/_check-bg-contrast.py
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  await page.waitForSelector(".home", { timeout: 20000 });
  await page.waitForTimeout(3500);

  const boxes = await page.evaluate(() => {
    /** 解析计算样式里的颜色：兼容 rgba()/rgb() 与现代的 color(srgb r g b / a) */
    const parse = (value: string): [number, number, number, number] | null => {
      if (!value) return null;
      if (value === "transparent") return [0, 0, 0, 0];
      const body = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
      // 注意剔除 "srgb" 这类单词：它会被 Number() 变成 NaN 并让整层变成 null（踩过）
      const nums = body
        .split(/[,\s/]+/)
        .filter(token => token.length > 0 && !Number.isNaN(Number(token)))
        .map(Number);
      if (nums.length < 3) return null;
      const alpha = nums.length > 3 ? nums[3]! : 1;
      if (value.includes("srgb") && !value.startsWith("rgb")) {
        return [nums[0]! * 255, nums[1]! * 255, nums[2]! * 255, alpha];
      }
      return [nums[0]!, nums[1]!, nums[2]!, alpha];
    };

    const out: Array<{
      text: string; color: string; x: number; y: number; w: number; h: number;
      layers: number[][]; gradientColors: number[][];
    }> = [];

    for (const element of Array.from(document.querySelectorAll<HTMLElement>(".home *"))) {
      const text = (element.textContent ?? "").trim();
      if (!text || text.length > 60) continue;
      if (Array.from(element.children).some(child => (child.textContent ?? "").trim())) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number(style.opacity) < 0.5) continue;

      // 从元素自身往上收集「有颜色的背景层」，直到 .home（含）
      const layers: number[][] = [];
      let node: HTMLElement | null = element;
      while (node && node !== document.documentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg[3] > 0.001) layers.push(bg);
        if (node.classList.contains("home")) break;
        node = node.parentElement;
      }

      // 渐变文字（background-clip:text）的「文字色」是透明的，
      // 真正显色的是 background-image 里的渐变色标 —— 把每个色标都当候选前景色收进来。
      const gradientColors: number[][] = [];
      const backgroundImage = style.backgroundImage || "";
      if (backgroundImage.includes("gradient")) {
        for (const match of backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)) {
          const parsed = parse("rgb(" + match[1]!.replace(/\//g, ",") + ")");
          if (parsed) gradientColors.push(parsed);
        }
      }

      out.push({
        text: text.slice(0, 24),
        color: style.color,
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        layers, gradientColors,
      });
    }
    return out;
  });

  await page.evaluate(() => {
    for (const selector of [".pageHeader", ".pageContent"]) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) el.style.visibility = "hidden";
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "home-bg-only.png") });

  writeFileSync(join(OUT, "bg-text-boxes.json"), JSON.stringify(boxes, null, 2), "utf-8");
  const withGlass = boxes.filter(b => b.layers.length > 0).length;
  console.log(`已采集 ${boxes.length} 个文字元素（其中 ${withGlass} 个带有背景层，含玻璃面）`);
  console.log("背景图：home-bg-only.png   元素表：bg-text-boxes.json");
} catch (error) {
  console.log("✗ " + String(error).split("\n")[0]);
} finally {
  await browser.close();
}
