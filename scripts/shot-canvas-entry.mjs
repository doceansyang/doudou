/**
 * 验证：点击「视频任务」是否直接落在无限画布上（不再经过任务列表）。
 */
const { chromium } = await import("playwright");

const OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/comoc-drama-client/scripts";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

const errors = [];
page.on("pageerror", (e) => errors.push("[pageerror] " + (e.message || String(e)).slice(0, 160)));

await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(4000);

// 点侧栏「视频任务」
const menu = page.getByText("视频任务", { exact: true }).first();
if (await menu.count()) {
  await menu.click();
  console.log("已点击「视频任务」");
} else {
  console.log("未找到「视频任务」菜单");
}
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/_shot-canvas-entered.png` });

const state = await page.evaluate(() => {
  const text = (document.body.innerText || "").replace(/\s+/g, " ");
  return {
    hasFlow: !!document.querySelector(".storyboard-canvas, .vue-flow"),
    nodeCount: document.querySelectorAll(".vue-flow__node").length,
    // 任务列表的特征文案
    showsTaskHub: text.includes("视频创作任务") || text.includes("CREATION TASKS"),
    showsWorkbench: text.includes("分镜") || text.includes("STORYBOARDS"),
    toonflowLeft: text.includes("Toonflow") || text.includes("交流群") || text.includes("商务合作"),
    text: text.slice(0, 300),
  };
});

console.log("\n=== 结果 ===");
console.log("无限画布存在 :", state.hasFlow);
console.log("画布节点数   :", state.nodeCount);
console.log("仍显示任务列表:", state.showsTaskHub);
console.log("已进入工作台 :", state.showsWorkbench);
console.log("Toonflow 残留:", state.toonflowLeft);
console.log("可见文本     :", state.text);
console.log("\n错误:", errors.length ? errors.slice(0, 4) : "无");

await browser.close();
