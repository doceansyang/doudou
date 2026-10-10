/**
 * 诊断：工作区页面是否正常渲染。
 * 打印 console / pageerror，并看页面上到底有什么。
 *
 * 跑法：cd toonflow && bun scripts/_probe-workspace-health.ts
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => { if (m.type() === "error") console.log("[console.error] " + m.text().slice(0, 400)); });
page.on("pageerror", (e) => console.log("[pageerror] " + String(e.message).split("\n")[0]));
page.on("response", (r) => { if (r.status() >= 400) console.log(`[HTTP ${r.status()}] ${r.url()}`); });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);
  console.log("URL      :", page.url());
  console.log("标题      :", await page.title());
  console.log("节点数    :", await page.locator(".vue-flow__node").count());
  console.log("画布容器  :", await page.locator(".vue-flow").count());
  console.log("设置按钮  :", await page.locator('button[title^="设置"]').count());
  const text = String(await page.evaluate(`document.body.innerText.slice(0, 300)`));
  console.log("正文前 300 字:\n" + text);
  await page.screenshot({ path: "assets/_workspace-health.png" });
} catch (error) {
  console.log("❌ " + String(error).split("\n")[0]);
} finally {
  await browser.close();
}
