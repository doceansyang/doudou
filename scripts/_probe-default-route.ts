/**
 * 验证：从根地址打开软件时，是否直接落在画布工作区（而不是首页）。
 *
 * 加载 http://localhost:3000/ 后等待前端路由跳转，检查最终 hash。
 * 期望：/#/workspace（不再是 /#/home）
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000);

const url = page.url();
const hash = url.split("#")[1] ?? "(无)";
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 120));

console.log("最终地址      :", url);
console.log("路由          :", hash);
console.log("页面文本前 120:", text);
console.log("是否直接进画布:", hash.includes("/workspace") ? "✓ 是" : "❌ 否（落到了 " + hash + "）");

await browser.close();
process.exit(hash.includes("/workspace") ? 0 : 1);
