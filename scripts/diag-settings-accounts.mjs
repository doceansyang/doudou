/**
 * 截图验证：Toonflow 设置里的「豆包账号绑定」区块。
 * 用来确认用户能在软件界面里找到绑定入口（而不只是一个独立网页）。
 */
const { chromium } = await import("playwright");
const { mkdir } = await import("node:fs/promises");

const OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/assets/doubao-inspect";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1760, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 180)));

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "load", timeout: 40000 });
await page.locator(".vue-flow__pane").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(4500);
console.log("[1] 画布已就绪");

// 打开设置
await page.locator('[aria-label="设置"]').first().click();
await page.waitForTimeout(1500);
console.log("[2] 设置弹窗已打开");

// 进「媒体模型」
await page.getByText("媒体模型", { exact: true }).first().click();
await page.waitForTimeout(2500);
console.log("[3] 已进入媒体模型面板");

// 找到豆包账号供应商，点「编辑模型」
const card = page.locator(".providerItem", { hasText: "豆包账号" }).first();
await card.waitFor({ timeout: 15000 });
await card.getByText("编辑模型").first().click();
await page.waitForTimeout(2500);
console.log("[4] 已打开豆包账号编辑弹窗");

const report = await page.evaluate(() => {
  // 页面上会同时存在「设置」弹窗与「编辑媒体供应商」弹窗（都 appendToBody），
  // 必须按标题挑出后者，不能直接取第一个 .el-dialog。
  const dialogs = [...document.querySelectorAll(".el-dialog")];
  const dialog =
    dialogs.find((d) => /编辑媒体供应商/.test(d.querySelector(".el-dialog__title")?.textContent || "")) ??
    dialogs.at(-1);
  const section = dialog?.querySelector(".accountSection");
  const rows = [...(section?.querySelectorAll(".accountCard") ?? [])].map((el) =>
    (el.textContent || "").replace(/\s+/g, " ").trim(),
  );
  const buttons = [...(section?.querySelectorAll("button") ?? [])].map((el) =>
    (el.textContent || "").replace(/\s+/g, " ").trim(),
  );
  return {
    hasSection: !!section,
    dialogCount: dialogs.length,
    title: (dialog?.querySelector(".el-dialog__title")?.textContent || "").trim(),
    accounts: rows,
    buttons,
  };
});
console.log("\n=== 弹窗内容 ===");
console.log("  页面弹窗数      :", report.dialogCount);
console.log("  目标弹窗标题    :", report.title);
console.log("  有账号绑定区块  :", report.hasSection ? "✓ 是" : "✗ 否");
console.log("  区块内按钮      :", JSON.stringify(report.buttons));
console.log("  账号数量        :", report.accounts.length);
report.accounts.forEach((text) => console.log("   -", text));
console.log("  运行时错误      :", errs.length ? errs.slice(0, 3) : "无");

await page.screenshot({ path: `${OUT}/settings-doubao-accounts.png` });
await browser.close();
