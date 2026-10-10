const { chromium } = await import("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: "C://Program Files//Google//Chrome//Application//chrome.exe",
});
const page = await browser.newPage();
const t0 = Date.now();
await page.goto("http://127.0.0.1:18999/index.html", { waitUntil: "commit" });
// 轮询直到 #app 出现实际内容
let ms = null;
for (let i = 0; i < 200; i++) {
  const len = await page.evaluate(() => (document.getElementById("app")?.innerHTML || "").length);
  if (len > 500) { ms = Date.now() - t0; break; }
  await page.waitForTimeout(100);
}
console.log("首次出现画面耗时：" + (ms === null ? "超过 20 秒未出现" : ms + " ms"));
const perf = await page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0];
  return { domInteractive: Math.round(n.domInteractive), loadEnd: Math.round(n.loadEventEnd), transfer: n.transferSize };
});
console.log("DOM 可交互:", perf.domInteractive + "ms", " load 完成:", perf.loadEnd + "ms");
await browser.close();
