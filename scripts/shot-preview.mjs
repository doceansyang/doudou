/**
 * 截取浏览器预览中的真实界面，验证画布与白块修复效果。
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
await page.screenshot({ path: `${OUT}/_shot-1-home.png` });
console.log("① 首页已截图");

// 进入项目（点第一个项目卡片）
const project = page.getByText("瑾瑜的白日梦", { exact: false }).first();
if (await project.count()) {
  await project.click().catch(() => {});
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/_shot-2-project.png` });
  console.log("② 项目页已截图");
}

// 尝试进入视频任务（画布）
for (const label of ["视频任务", "开始创作"]) {
  const el = page.getByText(label, { exact: false }).first();
  if (await el.count()) {
    await el.click().catch(() => {});
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}/_shot-3-canvas.png` });
    console.log(`③ 已点击「${label}」并截图`);
    break;
  }
}

// 报告画布区域状况
const state = await page.evaluate(() => {
  const flow = document.querySelector(".vue-flow, .storyboard-canvas");
  const nodes = document.querySelectorAll(".vue-flow__node");
  const whiteBlocks = document.querySelectorAll(".el-button, .el-card");
  return {
    url: location.hash,
    hasFlow: !!flow,
    nodeCount: nodes.length,
    uiComponents: whiteBlocks.length,
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
  };
});
console.log("\n=== 画布状态 ===");
console.log("路由      :", state.url);
console.log("canvas 存在:", state.hasFlow);
console.log("节点数    :", state.nodeCount);
console.log("UI 组件数 :", state.uiComponents);
console.log("可见文本  :", state.text);
console.log("\n错误:", errors.length ? errors.slice(0, 4) : "无");

await browser.close();
