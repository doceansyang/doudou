/** 验证：新安装版页面里能否看到用户原来的画布（6 节点）。 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => ({
  nodes: document.querySelectorAll(".vue-flow__node").length,
  edges: document.querySelectorAll(".vue-flow__edge").length,
  types: Array.from(document.querySelectorAll(".vue-flow__node")).map((el) => {
    const cls = el.className.match(/vue-flow__node-([a-zA-Z0-9]+)/);
    const label = (el.querySelector(".labelText")?.textContent || "").trim();
    return `${cls ? cls[1].replace("remote-", "") : "?"}(${label})`;
  }),
  projectName: (document.querySelector(".projectName, .workspaceName")?.textContent || "").trim(),
}));

console.log(`画布节点数: ${info.nodes}`);
console.log(`连线数: ${info.edges}`);
console.log(`节点明细: ${info.types.join(", ")}`);
await page.screenshot({ path: "assets/_install-verify.png" });
await browser.close();
