import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：打开真实的 Web UI，进到工作区，实测右上角「JinyuTV Agent」按钮上的图标
// 到底渲染出来没有。
//
// 为什么不用现成的 _shot-app.py：那个抓的是 WebView2 的窗口位图，而应用启动落在
// **首页**，Agent 按钮在工作区里 —— 得先点进项目才看得到。
//
// ⚠️ 判定用 `img.complete && naturalWidth > 0`，不能只看"元素存在"：
//    走的还是同一个 dev server（127.0.0.1:3000），页面本身没有任何改动风险。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
// 404 要知道**是哪个 URL**：只说"有个资源 404"等于没说
page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });

// 从首页点进项目 → 才会进工作区
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();

// ⚠️ Agent 面板默认是**展开**的（`agentVisible = ref(true)`），而那个按钮写着
//    `v-if="!agentVisible"` —— 不先把面板收起来，按钮根本不在 DOM 里。
// ⚠️ 这个按钮**不是立刻**就在的：面板的菜单要等对话加载完才渲染。
//    第一次跑就是在这里抢跑 —— 查的时候 count 是 0，30 秒后再看却是 1。
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
await closeBtn.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
if (await closeBtn.count()) {
  await closeBtn.click();
  await page.waitForTimeout(700);
  console.log("  已收起 Agent 面板（点「关闭对话」）");
} else {
  console.log("  !! 始终没等到「关闭对话」按钮");
}

let btn = page.locator(".agentButton").first();
try {
  await btn.waitFor({ state: "visible", timeout: 30000 });
} catch {
  // 进不去工作区就把现场存下来：URL、可见文案、整页截图，别只报"超时"
  console.log("!! 进工作区失败，现场诊断：");
  console.log("   URL:", page.url());
  console.log("   可见文本片段:", (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n+/g, " | "));
  console.log("   有弹窗:", await page.locator(".el-message-box, .el-dialog").count());
  console.log("   有 canvas 节点:", await page.locator(".vue-flow__node").count());
  console.log("   DOM 诊断:", JSON.stringify(await page.evaluate(() => {
    const panel = document.querySelector(".floatingAgent");
    return {
      workspacePage: !!document.querySelector(".workspacePage"),
      panel: !!panel,
      panelDisplay: panel ? getComputedStyle(panel).display : null,
      agentBtnByClass: document.querySelectorAll(".agentButton").length,
      agentBtnByLabel: document.querySelectorAll('[aria-label="JinyuTV Agent"]').length,
      closeDialogs: document.querySelectorAll("[aria-label=\"关闭对话\"]").length,
      topbar: (document.querySelector(".topbar") || {}).className || null,
      bodyChildren: Array.from(document.body.children).map(e => e.className || e.tagName).slice(0, 12),
    };
  }), null, 1));
  await page.screenshot({ path: join(outDir, "_agent-logo-probe-failed.png") });
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(1200);   // 等图片解码

const info = await page.evaluate(() => {
  const b = document.querySelector(".agentButton");
  if (!b) return null;
  const img = b.querySelector("img.agentLogo");
  const r = b.getBoundingClientRect();
  const cs = img ? getComputedStyle(img) : null;
  return {
    url: location.href,
    button: { w: Math.round(r.width), h: Math.round(r.height) },
    hasImg: !!img,
    src: img ? img.getAttribute("src") : null,
    complete: img ? img.complete : null,
    natural: img ? [img.naturalWidth, img.naturalHeight] : null,
    objectFit: cs ? cs.objectFit : null,
    // 旧实现留下的痕迹应为 0：两颗伪元素星球 + agentFlow 动画
    pseudoBeforeBg: getComputedStyle(b, "::before").backgroundImage,
    pseudoAfterBg: getComputedStyle(b, "::after").backgroundImage,
  };
});

console.log("=== 工作区右上角 Agent 按钮 ===");
console.log("  页面:", info.url);
console.log("  按钮尺寸:", info.button, "（应为 44x44）");
console.log("  有 img.agentLogo:", info.hasImg);
console.log("  src:", info.src);
console.log("  图片加载完成:", info.complete, " 原始尺寸:", info.natural, "（naturalWidth>0 才算真加载）");
console.log("  object-fit:", info.objectFit);
console.log("  旧星球残留 ::before =", info.pseudoBeforeBg, " ::after =", info.pseudoAfterBg);
console.log("  判定:", info.hasImg && info.complete && info.natural?.[0] > 0
  ? "✅ logo 图片已真实加载并渲染"
  : "❌ 图片没加载出来");

// 悬停出提示条，抓按钮附近一块，方便一眼看清
await btn.hover();
await page.waitForTimeout(700);
const box = await btn.boundingBox();
await page.screenshot({
  path: join(outDir, "_agent-logo-check.png"),
  clip: { x: Math.max(0, box.x - 150), y: Math.max(0, box.y - 30), width: 250, height: 130 },
});
await btn.screenshot({ path: join(outDir, "_agent-logo-btn.png") });
console.log("  截图:", join(outDir, "_agent-logo-check.png"));

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");

await browser.close();
