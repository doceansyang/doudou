/**
 * 一次性实测三个反馈：
 *   ① 修改画布后是否出现「画布保存失败」提示（监听 toast + console + 网络请求）
 *   ② 删除节点后 Ctrl+Z 能否恢复
 *   ③ 文本节点纵向拖拽手柄，高度能否变大
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon")) log(`  [console.error] ${t.slice(0, 200)}`);
});
// 记录画布保存相关的请求
page.on("response", async (res) => {
  const url = res.url();
  if ((url.includes("file") || url.includes("workspace") || url.includes("canvas")) && res.status() >= 400) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    log(`  [HTTP ${res.status()}] ${url.replace("http://localhost:3000", "")}  ${body}`);
  }
});

const toastTexts = () => page.evaluate(() =>
  Array.from(document.querySelectorAll(".el-message")).map((el) => (el.textContent || "").trim()).filter(Boolean)
);

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  const nodes = page.locator(".vue-flow__node");
  const count = () => page.evaluate(() => document.querySelectorAll(".vue-flow__node").length);
  const before = await count();
  log(`初始节点数: ${before}`);

  // 找节点：优先文本节点，其次任意视口内的
  const total = await nodes.count();
  const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
  let textIdx = -1, anyIdx = -1, textBox = null, anyBox = null;
  for (let i = 0; i < total; i++) {
    const cls = (await nodes.nth(i).getAttribute("class")) || "";
    const b = await nodes.nth(i).boundingBox();
    if (!inside(b)) continue;
    if (anyIdx < 0) { anyIdx = i; anyBox = b; }
    if (cls.includes("textNode")) { textIdx = i; textBox = b; break; }
  }
  log(`文本节点: #${textIdx}   任意节点: #${anyIdx}`);

  // ============ ① 保存 ============
  log("");
  log("=== ① 移动节点触发保存 ===");
  if (anyIdx >= 0) {
    await page.mouse.move(anyBox.x + anyBox.width / 2, anyBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(anyBox.x + anyBox.width / 2 + 60, anyBox.y + 12 + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(3000);
    const msgs = await toastTexts();
    log(`  提示消息: ${msgs.length ? msgs.join(" | ") : "（无）"}`);
    log(`  结果: ${msgs.some((m) => m.includes("保存失败")) ? "❌ 出现保存失败" : "✓ 未出现保存失败"}`);
  }

  // ============ ② 文本节点纵向缩放 ============
  log("");
  log("=== ② 文本节点纵向拖拽 ===");
  const targetIdx = textIdx >= 0 ? textIdx : anyIdx;
  const targetBox = textIdx >= 0 ? textBox : anyBox;
  const target = nodes.nth(targetIdx);

  for (const [dx, dy] of [[0.08, 0.07], [0.5, 0.1], [0.5, 0.5]]) {
    await page.mouse.click(targetBox.x + targetBox.width * dx, targetBox.y + targetBox.height * dy);
    await page.waitForTimeout(800);
    if (await page.locator(".vue-flow__node.selected").count() > 0) break;
  }
  const skeleton = target.locator(".nodeSkeleton").first();
  const startSize = await skeleton.boundingBox();
  const hb = await target.locator(".nodeResizeHandle").first().boundingBox();
  log(`  节点类型: ${(await target.getAttribute("class"))?.match(/vue-flow__node-([a-zA-Z0-9]+)/)?.[1] ?? "?"}`);
  log(`  起始尺寸: ${Math.round(startSize.width)} × ${Math.round(startSize.height)}`);
  log(`  手柄位置: ${Math.round(hb.x)},${Math.round(hb.y)}`);

  // 只向下拖（纯纵向）
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + i * 20);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const afterY = await skeleton.boundingBox();
  log(`  纯纵向拖动后: ${Math.round(afterY.width)} × ${Math.round(afterY.height)}`);
  log(`  结果: 高度 ${Math.round(startSize.height)} → ${Math.round(afterY.height)}（${afterY.height > startSize.height + 30 ? "✓ 变大" : "❌ 没变大"}）`);

  // 再向右下斜拖
  const hb2 = await target.locator(".nodeResizeHandle").first().boundingBox();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hb2.x + hb2.width / 2 + i * 12, hb2.y + hb2.height / 2 + i * 20);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const afterXY = await skeleton.boundingBox();
  log(`  斜向拖动后: ${Math.round(afterXY.width)} × ${Math.round(afterXY.height)}`);
  log(`  nodeSkeleton class: ${await skeleton.getAttribute("class")}`);

  // ============ ③ 删除 + 撤销 ============
  log("");
  log("=== ③ 删除节点后 Ctrl+Z ===");
  const box3 = await target.boundingBox();
  await page.mouse.click(box3.x + box3.width * 0.08, box3.y + box3.height * 0.07);
  await page.waitForTimeout(700);
  log(`  删除前选中: ${await page.evaluate(() => document.querySelectorAll(".vue-flow__node.selected").length)}`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1800);
  const afterDel = await count();
  log(`  删除后节点数: ${afterDel}（初始 ${before}）`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(2500);
  const afterUndo = await count();
  log(`  撤销后节点数: ${afterUndo}`);
  log(`  结果: ${afterUndo === before ? "✓ 撤销成功恢复" : "❌ 撤销未恢复（差 " + (before - afterUndo) + " 个）"}`);
  const msgs2 = await toastTexts();
  if (msgs2.length) log(`  提示消息: ${msgs2.join(" | ")}`);

  await page.screenshot({ path: "assets/_three-issues.png" });
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_three-issues.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
