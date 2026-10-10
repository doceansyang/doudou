/**
 * 最终验证（三）：实时打印日志，异常也落盘。
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
const flush = () => writeFileSync("assets/_resize-delete.txt", lines.join("\n") + "\n", "utf-8");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 160)}`));

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(2500);

  const nodes = page.locator(".vue-flow__node");
  const before = await nodes.count();
  log(`画布节点数: ${before}`);

  const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
  let idx = -1;
  let box = null;
  for (let i = 0; i < before; i++) {
    const b = await nodes.nth(i).boundingBox();
    log(`  节点[${i}] ${b ? `${Math.round(b.width)}×${Math.round(b.height)} @ ${Math.round(b.x)},${Math.round(b.y)}` : "无位置"}`);
    if (inside(b)) { idx = i; box = b; break; }
  }
  log(`选中用于验证的节点: ${idx >= 0 ? `#${idx}` : "无（全部在视口外）"}`);
  if (idx < 0) throw new Error("没有完整可见的节点");

  const target = nodes.nth(idx);
  const skeleton = target.locator(".nodeSkeleton").first();

  let selected = false;
  for (const [dx, dy] of [[0.08, 0.07], [0.5, 0.1], [0.5, 0.5], [0.25, 0.25]]) {
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await page.waitForTimeout(900);
    if (await page.locator(".vue-flow__node.selected").count() > 0) { selected = true; break; }
  }
  log(`节点已选中: ${selected ? "✓" : "❌"}`);

  log("");
  log("=== ① 右下角缩放手柄 ===");
  const handle = target.locator(".nodeResizeHandle").first();
  log(`  该节点内手柄数量: ${await target.locator(".nodeResizeHandle").count()}`);
  const hb = await handle.boundingBox();
  log(`  手柄位置: ${Math.round(hb.x)},${Math.round(hb.y)}  尺寸 ${Math.round(hb.width)}×${Math.round(hb.height)}`);
  const snapshot = () => page.evaluate(() => {
    const list = Array.from(document.querySelectorAll(".nodeSkeleton")).map((el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    const parents = Array.from(document.querySelectorAll(".nodeSkeleton")).map((el) => {
      const p = el.parentElement;
      return p ? p.className.split(" ").slice(0, 3).join(".") : "(无父元素)";
    });
    return {
      nodes: document.querySelectorAll(".vue-flow__node").length,
      skeletons: document.querySelectorAll(".nodeSkeleton").length,
      inFlow: document.querySelectorAll(".vue-flow__node .nodeSkeleton").length,
      handles: document.querySelectorAll(".nodeResizeHandle").length,
      sizes: list,
      parents,
      sized: document.querySelectorAll(".nodeSkeleton.sized").length,
    };
  });
  const beforeShot = await snapshot();
  log(`  拖动前: 节点=${beforeShot.nodes} 骨架=${beforeShot.skeletons} 手柄=${beforeShot.handles} 已缩放=${beforeShot.sized}`);
  log(`          尺寸列表: ${beforeShot.sizes.join(", ")}`);

  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForTimeout(400);
  log(`  悬停透明度: ${await handle.evaluate((el) => getComputedStyle(el).opacity)}`);

  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 14, hb.y + hb.height / 2 + i * 10);
  await page.mouse.up();
  await page.waitForTimeout(2000);

  const afterShot = await snapshot();
  log(`  拖动后: 节点=${afterShot.nodes} 骨架=${afterShot.skeletons}（画布内 ${afterShot.inFlow}） 手柄=${afterShot.handles} 已缩放=${afterShot.sized}`);
  log(`          尺寸列表: ${afterShot.sizes.join(", ")}`);
  log(`          骨架父元素: ${afterShot.parents.join(" | ")}`);
  await page.screenshot({ path: "assets/_resize-after.png" });
  log(`  结果: ${afterShot.sized > 0 ? "✓ 已有节点进入「已缩放」状态（尺寸已写入节点）" : "❌ 尺寸未变化"}`);
  log(`  依据: sized 数量 ${beforeShot.sized} → ${afterShot.sized}`);

  log("");
  log("=== ② Delete 键删除 ===");
  const countNodes = () => page.evaluate(() => document.querySelectorAll(".vue-flow__node").length);
  const nowBox = await page.locator(".vue-flow__node").nth(idx).boundingBox().catch(() => null);
  if (nowBox) await page.mouse.click(nowBox.x + nowBox.width * 0.08, nowBox.y + nowBox.height * 0.07);
  await page.waitForTimeout(900);
  log(`  删除前选中: ${await page.evaluate(() => document.querySelectorAll(".vue-flow__node.selected").length)}`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1600);
  const afterDelete = await countNodes();
  log(`  删除后节点数: ${afterDelete}（初始 ${before}）→ ${afterDelete === before - 1 ? "✓ 已删除 1 个" : "❌ 未删除"}`);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(2000);
  const afterUndo = await countNodes();
  log(`  撤销后节点数: ${afterUndo} → ${afterUndo === before ? "✓ 已恢复" : "⚠ 未完全恢复"}`);

  await page.screenshot({ path: "assets/_resize-delete.png" });
} catch (error) {
  log("");
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  flush();
  await browser.close();
}
