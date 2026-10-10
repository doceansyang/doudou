/**
 * 真机验证：模拟「同事电脑首次打开」——空工作区能否自动得到一张画布。
 *
 * 做法：用本机 Chrome（Playwright）真实加载 http://localhost:3000/#/workspace，
 * 等前端初始化，读页面文本看是否出现「画布1」，并截图留证。
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
// 前端要先拿到项目目录、再列画布、没有就新建，给足时间
await page.waitForTimeout(12000);

const title = await page.title();
const text = await page.evaluate(() => document.body.innerText);

// 画布名出现在左上角下拉里；同时看是否出现「新建画布」等空态提示
const hasCanvas1 = /画布1/.test(text);
const emptyHints = ["暂无画布", "没有画布", "新建画布"].filter((k) => text.includes(k));

console.log("页面标题      :", title);
console.log("出现「画布1」 :", hasCanvas1 ? "是" : "否");
console.log("空态提示      :", emptyHints.length ? emptyHints.join(" / ") : "(无)");
console.log("页面文本前 200 字:", text.replace(/\s+/g, " ").slice(0, 200));
console.log("控制台错误    :", consoleErrors.length, consoleErrors.slice(0, 3));
console.log("页面异常      :", pageErrors.length, pageErrors.slice(0, 3));

await page.screenshot({ path: "assets/_fresh-install.png", fullPage: false });
console.log("截图          : toonflow/assets/_fresh-install.png");

await browser.close();
