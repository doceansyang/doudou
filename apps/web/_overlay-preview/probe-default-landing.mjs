import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const info = await page.evaluate(() => ({
  hash: location.hash,
  href: location.href,
  homeCards: document.querySelectorAll(".projectEntry").length,
  helloWelcome: (document.body.innerText || "").includes("快速开始"),
  helloPrivate: (document.body.innerText || "").includes("添加私有提供商"),
  text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 140),
}));
console.log(JSON.stringify(info, null, 1));
const settings = await page.evaluate(async () => {
  const r = await fetch("/api/settings/get", { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } });
  const j = await r.json();
  return { code: j.code, helloCompleted: j?.data?.helloCompleted, keys: Object.keys(j?.data || {}) };
});
console.log("服务端设置:", JSON.stringify(settings));
await page.screenshot({ path: "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/scripts/_out/default-landing.png" });
await browser.close();
