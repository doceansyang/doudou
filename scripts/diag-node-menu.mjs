/**
 * 验证：双击画布空白是否弹出节点菜单，以及能否真的建出各类节点。
 */
const { chromium } = await import("playwright");

const OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/comoc-drama-client/scripts";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("[console] " + m.text().slice(0, 200));
});

await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(4000);
await page.getByText("视频任务", { exact: true }).first().click();
await page.waitForTimeout(6000);

// 双击画布空白区域（避开中央节点）
const pane = await page.locator(".vue-flow__pane").first().boundingBox();
const px = pane.x + pane.width * 0.22;
const py = pane.y + pane.height * 0.78;
await page.mouse.dblclick(px, py);
await page.waitForTimeout(1200);

const menu = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".el-dropdown-menu__item")].filter(
    (el) => el.getBoundingClientRect().height > 8,
  );
  return {
    visible: items.length > 0,
    labels: items.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
  };
});
console.log("=== 节点菜单 ===");
console.log("  弹出     :", menu.visible ? "✓ 是" : "✗ 否");
console.log("  菜单项   :", JSON.stringify(menu.labels));

// 点「文本节点」
let textNodeCreated = false;
if (menu.visible) {
  const item = page.locator(".el-dropdown-menu__item", { hasText: "文本节点" }).first();
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(1200);
    textNodeCreated = await page.evaluate(() => document.querySelectorAll(".text-node").length > 0);
  }
}
console.log("\n=== 建节点 ===");
console.log("  文本节点已建出 :", textNodeCreated ? "✓ 是" : "✗ 否");
console.log("  画布节点总数   :", await page.evaluate(() => document.querySelectorAll(".vue-flow__node").length));

await page.screenshot({ path: `${OUT}/_shot-node-menu.png` });
console.log("\n运行时错误:", errs.length ? errs.slice(0, 4) : "无");
await browser.close();
