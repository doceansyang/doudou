import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 参数对照栅格的截图器。只为「挑参数」存在，不参与交付验证（那是 verify.mjs 的事）。
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const js = readFileSync(join(dist, "preview.js"), "utf8");
const css = readFileSync(join(dist, "preview.css"), "utf8");

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#141418;font-family:"Microsoft YaHei UI",sans-serif;}
  body{padding:16px;}
  .grid{display:grid;grid-template-columns:repeat(3,360px);gap:14px;}
  .cell{display:flex;flex-direction:column;gap:4px;}
  .tile{position:relative;width:360px;height:220px;border-radius:8px;overflow:hidden;background:#0b0713;}
  .tile canvas{position:absolute;inset:0;width:100%;height:100%;}
  /* 和遮罩里同一层暗罩：挑参数时要连着"文字底衬"一起看，否则会挑到太亮的 */
  .scrim{position:absolute;inset:0;background:radial-gradient(ellipse 78% 62% at 50% 50%, rgb(9 6 18 / 58%) 0%, rgb(9 6 18 / 30%) 52%, rgb(9 6 18 / 0%) 100%);}
  .tag{font-size:11px;color:rgb(255 255 255 / 55%);}
  .tile--empty{background:#17171c;}
  .tile .tag{position:absolute;left:8px;bottom:6px;font-size:11px;color:rgb(255 255 255 / 62%);z-index:2;}
</style>
<style>${css}</style></head>
<body><div id="app"></div></body></html>`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.setContent(html, { waitUntil: "load" });
await page.addScriptTag({ content: js });
await page.waitForTimeout(14000);   // 等三波都挂载完，各自跑出不同相位
const info = await page.evaluate(() => document.querySelectorAll(".tile canvas").length);
console.log("canvas 数量 =", info, "（应为 9）");
console.log("页面错误:", errors.length ? errors.join("\n") : "（无）");
await page.locator(".grid").screenshot({ path: join(outDir, "_strands-variants.png") });
console.log("已输出", join(outDir, "_strands-variants.png"));
await browser.close();
