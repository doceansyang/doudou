/**
 * 通过 CDP 连入 pywebview 的 WebView2，抓取页面真实渲染结果。
 * CDP 截图的是「页面内容」，不受任何窗口遮挡影响 —— 这是判断黑屏最可靠的手段。
 */
const { chromium } = await import("playwright");

let browser;
for (let i = 0; i < 20; i++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (!browser) {
  console.log("CDP 连接失败：9222 端口未就绪");
  process.exit(1);
}

const contexts = browser.contexts();
const pages = contexts.flatMap((c) => c.pages());
console.log("CDP 已连接，页面数：" + pages.length);

const page = pages[0];
if (!page) {
  console.log("没有找到页面");
  await browser.close();
  process.exit(1);
}

// 等页面渲染
let appLen = 0;
for (let i = 0; i < 40; i++) {
  appLen = await page.evaluate(() => (document.getElementById("app")?.innerHTML || "").length).catch(() => 0);
  if (appLen > 500) break;
  await new Promise((r) => setTimeout(r, 500));
}

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  ready: document.readyState,
  appLen: (document.getElementById("app")?.innerHTML || "").length,
  text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 220),
  bg: getComputedStyle(document.body).backgroundColor,
})).catch((e) => ({ error: String(e) }));

console.log("\n=== 页面实况 ===");
console.log("URL      :", info.url);
console.log("标题     :", info.title);
console.log("readyState:", info.ready);
console.log("#app 长度:", info.appLen);
console.log("body 背景:", info.bg);
console.log("可见文本 :", info.text || info.error);

const out = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/_diag-cdp.png";
await page.screenshot({ path: out }).catch((e) => console.log("截图失败:", String(e)));
console.log("\n已截图:", out);

await browser.close();
