/** 调试：双击空白为什么没弹节点菜单。 */
const { chromium } = await import("playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
page.on("console", (m) => { if (/probe|Vue warn/.test(m.text())) console.log("[" + m.type() + "]", m.text().slice(0,220)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e.message).slice(0, 200)));

await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(4000);
await page.getByText("视频任务", { exact: true }).first().click();
await page.waitForTimeout(6000);

// 画布上的节点清单
const nodes = await page.evaluate(() =>
  [...document.querySelectorAll(".vue-flow__node")].map((el) => ({
    cls: String(el.className).replace("vue-flow__node ", "").slice(0, 40),
    id: el.getAttribute("data-id"),
  }))
);
console.log("节点:", JSON.stringify(nodes));

// 在画布左下角空白处双击，并打印命中的元素类名
const pane = await page.locator(".vue-flow__pane").first().boundingBox();
const px = pane.x + 60;
const py = pane.y + pane.height - 120;
const target = await page.evaluate(
  ([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? String(el.className).slice(0, 80) + " | " + el.tagName : "none";
  },
  [px, py]
);
console.log("双击位置:", Math.round(px), Math.round(py), "命中:", target);

await page.mouse.dblclick(px, py);
await page.waitForTimeout(1500);

const after = await page.evaluate(() => ({
  dropdowns: document.querySelectorAll(".el-dropdown__popper").length,
  visibleMenus: [...document.querySelectorAll(".el-dropdown-menu")].map((el) => ({
    hidden: el.closest(".el-popper")?.getAttribute("aria-hidden"),
    h: Math.round(el.getBoundingClientRect().height),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
  })),
}));
console.log("双击后:", JSON.stringify(after, null, 1));

await browser.close();
