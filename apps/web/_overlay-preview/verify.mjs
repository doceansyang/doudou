import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 交付前验证：把真实组件渲染出来，分时截图 + 读取真实百分比，确认
//   (1) 能渲染不报错 (2) WebGL 丝带背景真的建起来了 (3) 画面在动
//   (4) WebGL 不可用时 CSS 兜底能顶上 (5) 文字压在丝带上的对比度够
//
// 图像分析（动没动 / 对比度）**交给 Python + Pillow** 做，见
// scripts/analyze-gen-overlay.py —— Node 侧没有图像库，之前尝试在页面里用
// Image + canvas 解码 base64，结果 onerror 抛 Event、查不出原因，不值得再踩。
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

// 无头 Chrome 默认会拒掉 WebGL（没有 GPU 时也不给 SwiftShader），必须显式放行，
// 否则测出来的永远是"降级路径"，等于没验到丝带。
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const errors = [];
const shots = {};   // 交给 Python 分析的图 + 坐标

const ctx = await browser.newContext({ viewport: { width: 1240, height: 420 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
  if (m.type() === "warning" && m.text().includes("strandsBackdrop")) errors.push("warn: " + m.text());
});
await page.setContent(html, { waitUntil: "load" });
await page.addScriptTag({ content: js });

const samples = [
  { at: 700, name: "t0.7s" },
  { at: 6000, name: "t6s" },
  { at: 24000, name: "t24s" },
];

const started = Date.now();
const readPercent = async () => (await page.textContent(".genPercent").catch(() => null));

console.log("=== 渲染验证 ===");
for (const s of samples) {
  const wait = s.at - (Date.now() - started);
  if (wait > 0) await page.waitForTimeout(wait);
  const pct = await readPercent();
  const info = await page.evaluate(() => {
    const sizeOf = (el) => (el ? getComputedStyle(el).fontSize : null);
    const stages = Array.from(document.querySelectorAll(".genOverlay"));
    const canvas = document.querySelector(".genBackdrop canvas");
    const gl = canvas ? canvas.getContext("webgl2") : null;
    return {
      ariaNow: document.querySelector(".genOverlay")?.getAttribute("aria-valuenow"),
      ariaRole: document.querySelector(".genOverlay")?.getAttribute("role"),
      tabular: document.querySelector(".genPercent")
        ? getComputedStyle(document.querySelector(".genPercent")).fontVariantNumeric : null,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      glLost: gl ? gl.isContextLost() : null,
      glRenderer: gl ? (() => { const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; })() : null,
      fallbackVisible: !!document.querySelector(".genBlob--a"),
      fonts: stages.map((st) => {
        const r = st.getBoundingClientRect();
        return {
          stage: Math.round(r.width) + "x" + Math.round(r.height),
          pct: sizeOf(st.querySelector(".genPercent")),
          label: sizeOf(st.querySelector(".genLabel")),
        };
      }),
    };
  });
  console.log(`  ${s.name}: 显示=${pct}  aria-valuenow=${info.ariaNow}  role=${info.ariaRole}`);
  console.log(`        canvas 位图=${JSON.stringify(info.canvas)}  上下文丢失=${info.glLost}  GPU=${info.glRenderer}`);
  console.log(`        CSS 兜底层可见=${info.fallbackVisible}(应为 false)  tabular-nums=${info.tabular}`);
  console.log(`        三档字号=${JSON.stringify(info.fonts)}`);
  await page.screenshot({ path: join(outDir, "_gen-frame-" + s.name + ".png") });
  if (s.name === "t24s") shots.motionA = join(outDir, "_gen-motion-a.png");
}

// 背景是否真的在动：同一块舞台隔 800ms 抓两张，交给 Python 比对
const stageLg = page.locator(".stage").nth(2);
await stageLg.screenshot({ path: join(outDir, "_gen-motion-a.png") });
await page.waitForTimeout(800);
await stageLg.screenshot({ path: join(outDir, "_gen-motion-b.png") });

// 对比度：藏掉**字形填色**但保留文字自带的深色描晕，量"字形边缘实际看到的底色"。
//   · 不能拿文字像素去跟周边比（抗锯齿边缘＝假低对比）；
//   · 也不该用 visibility:hidden —— 那会把 text-shadow 一起藏掉，
//     而现在没有整幅暗罩了，可读性正是靠那圈描晕，藏了就等于漏掉保护。
const boxes = {};
for (const [key, idx] of [["sm", 0], ["md", 1], ["lg", 2]]) {
  // ⚠️ 不能用 .stage 这种类选择器：三个舞台都带 .stage，strict mode 会直接报歧义
  const stage = page.locator(".stage").nth(idx);
  const sBox = await stage.boundingBox();
  const pBox = await stage.locator(".genPercent").boundingBox();
  await page.evaluate(() => {
    document.querySelectorAll(".genPercent, .genLabel").forEach((el) => { el.style.color = "transparent"; });
  });
  const file = join(outDir, `_gen-contrast-${key}.png`);
  await stage.screenshot({ path: file });
  boxes[key] = {
    file,
    box: {
      x: Math.round(pBox.x - sBox.x),
      y: Math.round(pBox.y - sBox.y),
      w: Math.round(pBox.width),
      h: Math.round(pBox.height),
    },
  };
  await page.evaluate(() => {
    document.querySelectorAll(".genPercent, .genLabel").forEach((el) => { el.style.color = ""; });
  });
}

await page.screenshot({ path: join(outDir, "_gen-overlay-full.png") });

// ── 降级路径：WebGL2 不可用时必须回退到 CSS 背景，不能是白板 ──
const page2 = await ctx.newPage();
page2.on("pageerror", (e) => errors.push("[fallback] " + String(e)));
await page2.setContent(html, { waitUntil: "load" });
// ⚠️ 不能用 addInitScript：它和 setContent 之间有时序竞态，实测补丁没生效
//    （WebGL 照常建起来，于是"降级路径"验了个寂寞）。改成先打补丁、再加载组件，
//    顺序由 await 保证。
await page2.evaluate(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (String(type).startsWith("webgl")) return null;   // 模拟显卡/驱动不支持
    return orig.call(this, type, ...rest);
  };
});
await page2.addScriptTag({ content: js });
await page2.waitForTimeout(1200);
const fb = await page2.evaluate(() => {
  const cv = document.querySelector(".genBackdrop canvas");
  return {
    canvasInDom: !!cv,
    canvasShown: cv ? getComputedStyle(cv).display !== "none" : false,
    blobs: document.querySelectorAll(".genBlob").length,
    sweep: !!document.querySelector(".genSweep"),
    pct: document.querySelector(".genPercent")?.textContent?.trim(),
  };
});
console.log(`\n=== 降级路径（getContext('webgl2') 返回 null）===`);
console.log(`  canvas 在 DOM=${fb.canvasInDom}(占位用)  实际显示=${fb.canvasShown}(应为 false)`);
console.log(`  CSS 光斑=${fb.blobs}(3 个舞台 × 2 = 6)  扫光=${fb.sweep}  百分比=${fb.pct}`);
console.log(`  判定：${!fb.canvasShown && fb.blobs === 6 && fb.pct ? "✅ 已回退 CSS 背景" : "❌ 回退异常"}`);
await page2.screenshot({ path: join(outDir, "_gen-overlay-fallback.png") });

writeFileSync(join(outDir, "_gen-metrics.json"), JSON.stringify({
  motion: { a: join(outDir, "_gen-motion-a.png"), b: join(outDir, "_gen-motion-b.png") },
  contrast: boxes,
}, null, 2));

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");

await browser.close();
