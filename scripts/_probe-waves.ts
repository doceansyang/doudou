// 首页波浪背景验证：真机 GPU 帧率 + 渲染截图。
//
// 为什么不用无头模式：无头 Chromium 走 SwiftShader 软件渲染，帧率毫无参考价值。
// 这里用有头 Chrome（与 WebView2 同为 Chromium 内核、同一块 GPU），开
// localStorage.jinyutv.bgDebug=1 让组件显示 FPS 角标，再把它读出来。
//
// 用法：bun scripts/_probe-waves.ts
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/scripts/_out";
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const lines: string[] = [];
const log = (text: string) => {
  lines.push(text);
  console.log(text);
};

const executablePath = CANDIDATES.find(path => existsSync(path));
if (!executablePath) {
  console.log("✗ 找不到 Chrome/Edge");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

log("浏览器：" + executablePath);
const browser = await chromium.launch({ executablePath, headless: false, args: ["--window-position=40,40"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 让组件显示帧率角标
await page.addInitScript(() => {
  try { localStorage.setItem("jinyutv.bgDebug", "1"); } catch { /* 忽略 */ }
});
// 把 console 里的告警（着色器编译失败等）转出来，方便定位
page.on("console", message => {
  const text = message.text();
  if (/GradientWaves|WebGL|GL_|shader/i.test(text)) log("  [页面] " + text);
});
page.on("pageerror", error => log("  [页面异常] " + String(error).split("\n")[0]));

try {
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const canvasInfo = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".gradientWavesCanvas");
    if (!canvas) return null;
    const gl = canvas.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
      renderer: dbg ? gl?.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "未取到",
    };
  });
  log("画布：" + JSON.stringify(canvasInfo));

  // 采样 6 秒帧率（组件每秒刷新一次角标）
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    const text = await page.locator(".fpsBadge").first().innerText().catch(() => "");
    samples.push(Number(text.replace(/\D/g, "")) || 0);
  }
  log("帧率采样：" + samples.join(" / ") + " FPS");
  log("结论：" + (Math.max(...samples) >= 29 ? "达到 30 帧上限 ✓" : "未跑满上限，需下调参数"));

  // 鼠标移到左上方，看视差是否生效（背景跟着轻微偏移）
  await page.mouse.move(300, 200);
  await page.waitForTimeout(900);

  await page.screenshot({ path: join(OUT, "home-waves.png") });
  log("截图：home-waves.png");

  // 顺便量一下底部文字区域的明暗（遮罩是否够用）
  const contrast = await page.evaluate(() => {
    const probe = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return { selector, color: style.color, fontSize: style.fontSize };
    };
    return [probe(".projectList .sectionHeader h2"), probe(".projectList .projectPath")].filter(Boolean);
  });
  log("底部文字：" + JSON.stringify(contrast));
} catch (error) {
  log("✗ 异常：" + String(error).split("\n")[0]);
} finally {
  writeFileSync(join(OUT, "waves-probe.log"), lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
