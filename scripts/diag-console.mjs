/**
 * 抓取全部控制台输出（含 warning），定位 ShotNode 为何未渲染。
 */
const { chromium } = await import("playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${(e.message || String(e)).slice(0, 300)}`));

await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(3500);
await page.getByText("视频任务", { exact: true }).first().click().catch(() => {});
await page.waitForTimeout(7000);

console.log("=== 控制台（" + logs.length + " 条）===");
logs.slice(0, 25).forEach((l) => console.log(l));

const extra = await page.evaluate(() => {
  const node = document.querySelector(".vue-flow__node");
  return {
    nodeKeys: node ? Object.keys(node.__vueParentComponent?.props || {}).slice(0, 12) : [],
    hasCanvasGlobal: typeof window.__VUE_FLOW__,
  };
});
console.log("\n=== 附加 ===");
console.log(JSON.stringify(extra));
await browser.close();
