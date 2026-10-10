/**
 * 抓取拖动缩放手柄时的真实错误（console + 未捕获异常 + 节点错误提示全文）。
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const VIEW = { width: 1600, height: 950 };
const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };
const flush = () => writeFileSync("assets/_resize-error.txt", lines.join("\n") + "\n", "utf-8");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error" || m.type() === "warning" || text.includes("not a function") || text.includes("TypeError")) {
    log(`  [console.${m.type()}] ${text.slice(0, 400)}`);
  }
});
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 300)}\n      ${(e.stack || "").split("\n").slice(0, 4).join("\n      ")}`));

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);
  log("（页面已加载，开始拖动前）");

  const nodes = page.locator(".vue-flow__node");
  const total = await nodes.count();
  const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
  let idx = -1, box = null;
  for (let i = 0; i < total; i++) {
    const b = await nodes.nth(i).boundingBox();
    if (inside(b)) { idx = i; box = b; break; }
  }
  log(`待测节点: #${idx}`);
  const hb = await nodes.nth(idx).locator(".nodeResizeHandle").first().boundingBox();
  log(`手柄: ${Math.round(hb.x)},${Math.round(hb.y)} ${Math.round(hb.width)}x${Math.round(hb.height)}`);

  log("");
  log("=== 开始拖动 ===");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 16, hb.y + hb.height / 2 + i * 12);
  await page.mouse.up();
  await page.waitForTimeout(1500);

  log("");
  log("=== 节点错误提示 ===");
  const errText = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".nodeSkeleton").forEach((el) => {
      const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (txt.includes("error") || txt.includes("not a function")) out.push(txt.slice(0, 200));
    });
    return out;
  });
  errText.forEach((t) => log(`  ${t}`));
  if (!errText.length) log("  （界面上没有错误提示）");

  const state = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".vue-flow__node").length,
    skeletons: document.querySelectorAll(".nodeSkeleton").length,
    sized: document.querySelectorAll(".nodeSkeleton.sized").length,
    styleOfFirst: document.querySelector(".vue-flow__node")?.getAttribute("style")?.slice(0, 120),
  }));
  log("");
  log(`状态: 节点=${state.nodes} 骨架=${state.skeletons} 已缩放=${state.sized}`);
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  flush();
  await browser.close();
}
