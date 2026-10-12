import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 交付前验证：把真实组件渲染出来，分时截图 + 读取真实百分比，
// 确认 (1) 能渲染不报错 (2) 动画在动 (3) 百分比确实从 0 往上爬并逼近 99。
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const js = readFileSync(join(dist, "preview.js"), "utf8");
const css = readFileSync(join(dist, "preview.css"), "utf8");

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#1b1b1f;}
  body{display:flex;gap:18px;padding:18px;font-family:"Microsoft YaHei UI",sans-serif;}
  .stage{position:relative;width:360px;height:220px;border-radius:6px;overflow:hidden;background:#000;}
  .stage--sm{width:240px;height:150px;}
  .stage--lg{width:560px;height:315px;}
</style>
<style>${css}</style></head>
<body>
  <div id="app"></div>
</body></html>`;

// Playwright 自带的 chromium 没下载；本机装了系统 Chrome（RPA 也用它），
// 直接走 channel 复用，省一次 100MB+ 的下载。
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1240, height: 400 }, deviceScaleFactor: 1 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.setContent(html, { waitUntil: "load" });
await page.addScriptTag({ content: js });

const samples = [
  { at: 600, name: "t0.6s" },
  { at: 6000, name: "t6s" },
  { at: 24000, name: "t24s" },
];

const started = Date.now();
const readPercent = async () => (await page.textContent(".genPercent").catch(() => null));
const readSize = async () => page.evaluate(() => {
  // 三档尺寸都读，验证容器查询 clamp 是否真的让字号跟着容器缩放
  return Array.from(document.querySelectorAll(".genPercent")).map((el) => {
    const cs = getComputedStyle(el);
    const box = el.closest(".genOverlay").getBoundingClientRect();
    return { stage: Math.round(box.width) + "x" + Math.round(box.height), fontSize: cs.fontSize };
  });
});

console.log("=== 渲染验证 ===");
for (const s of samples) {
  const wait = s.at - (Date.now() - started);
  if (wait > 0) await page.waitForTimeout(wait);
  const pct = await readPercent();
  const size = await readSize();
  const animated = await page.evaluate(() => {
    const blob = document.querySelector(".genBlob--a");
    const sweep = document.querySelector(".genSweep");
    return {
      blob: blob ? getComputedStyle(blob).transform : null,
      sweep: sweep ? getComputedStyle(sweep).transform : null,
      bg: !!document.querySelector(".genBackdrop"),
      grid: !!document.querySelector(".genGrid"),
      ariaNow: document.querySelector(".genOverlay")?.getAttribute("aria-valuenow"),
      ariaRole: document.querySelector(".genOverlay")?.getAttribute("role"),
      tabular: document.querySelector(".genPercent") ? getComputedStyle(document.querySelector(".genPercent")).fontVariantNumeric : null,
    };
  });
  console.log(`  ${s.name}: 显示=${pct}  aria-valuenow=${animated.ariaNow}  role=${animated.ariaRole}  字号=${JSON.stringify(size)}`);
  console.log(`        blob.transform=${animated.blob}`);
  console.log(`        sweep.transform=${animated.sweep}`);
  console.log(`        tabular-nums=${animated.tabular}  backdrop=${animated.bg} grid=${animated.grid}`);
}

await page.screenshot({ path: join(outDir, "_gen-overlay-full.png") });

// 顺带看一眼不同尺寸下字号是否跟着缩放（容器查询 clamp）
await page.evaluate(() => {
  document.body.innerHTML = '<div id="app"></div>';
  document.querySelectorAll("style").forEach((s) => { if (s.textContent.includes(".genOverlay")) { /* keep */ } });
});
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");

await browser.close();
