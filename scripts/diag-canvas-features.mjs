/**
 * 功能验证：确认搬入的成熟组件在 Element Plus 注册后「真的可交互」。
 * 检查项：el-card 工具栏、缩放弹层、悬停提示、框选工具条。
 */
const { chromium } = await import("playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 140)));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[HTTP " + r.status() + "]", r.url().slice(0, 120));
});

await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(4000);
await page.getByText("视频任务", { exact: true }).first().click();
await page.waitForTimeout(5500);

const parts = await page.evaluate(() => ({
  elCard: document.querySelectorAll(".el-card").length,
  elButton: document.querySelectorAll(".el-card .el-button").length,
  rawTags: document.querySelectorAll("el-card, el-button, el-popover, el-tooltip, el-dialog").length,
  toolButtons: document.querySelectorAll(".el-card .el-button[aria-label]").length,
  zoomLabel: document.querySelector('.toolButton[aria-label="缩放菜单"]')?.textContent?.trim() || "",
  selectionToolbar: document.querySelectorAll(".selectionToolbar, .selection-toolbar").length,
  visiblePopovers: [...document.querySelectorAll(".el-popper")].filter((p) => p.getBoundingClientRect().height > 8).length,
}));

console.log("=== 组件挂载 ===");
console.log("  el-card 渲染数        :", parts.elCard);
console.log("  el-card 内可点按钮数  :", parts.elButton);
console.log("  未解析的原始标签数    :", parts.rawTags, parts.rawTags === 0 ? "✓ 全部已注册" : "✗ 仍有未注册组件");
console.log("  缩放按钮文案          :", JSON.stringify(parts.zoomLabel));

// 点击缩放按钮，验证弹层真的能打开
const zoomBtn = page.locator('.toolButton[aria-label="缩放菜单"]').first();
let popoverOpened = false;
if (await zoomBtn.count()) {
  await zoomBtn.click();
  await page.waitForTimeout(700);
  popoverOpened = await page.evaluate(() =>
    [...document.querySelectorAll(".el-popper")].some((p) => {
      const r = p.getBoundingClientRect();
      return r.width > 20 && r.height > 20 && /放大/.test(p.textContent || "");
    })
  );
  await page.keyboard.press("Escape");
}
console.log("\n=== 交互 ===");
console.log("  缩放弹层可打开        :", popoverOpened ? "✓ 是" : "✗ 否");

// 悬停整理按钮，验证 el-tooltip 生效
const arrange = page.locator('.toolButton[aria-label="整理画布"]').first();
let tipVisible = false;
if (await arrange.count()) {
  await arrange.hover();
  await page.waitForTimeout(900);
  tipVisible = await page.evaluate(() => {
    const tips = [...document.querySelectorAll(".el-popper")];
    return tips.some((t) => t.getBoundingClientRect().height > 8 && /整理画布/.test(t.textContent || ""));
  });
}
console.log("  悬停提示可显示        :", tipVisible ? "✓ 是" : "✗ 否");

console.log("\n运行时错误:", errs.length ? errs.slice(0, 3) : "无");
await browser.close();
