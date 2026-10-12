// 探针：埋点已关闭后的界面验收。
//
// 判据（三条，缺一不可）：
//  ① 页面能正常打开并使用（应用没有被改坏）
//  ② 全部出站请求里**一次都不出现 telemetry / api.toonflow.net**（不再向任何外部服务发统计）
//  ③ 设置→隐私面板如实显示「不收集、不上传任何使用数据」，且**没有**那个失效的数据收集开关
//
// ⚠️ 只读：不改设置、不装插件。
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const requests = [];
page.on("request", (r) => requests.push(r.url()));

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
};

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator('button[aria-label="设置"]').first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1500);

// 在设置里到处点点，触发尽可能多的页面/事件（埋点若还在，必然在这期间上报）
for (const label of ["插件市场", "文本模型", "MCP"]) {
  const nav = await page.evaluate((text) => {
    const cands = [];
    document.querySelectorAll("*").forEach((el) => {
      if ((el.textContent || "").trim() !== text) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      let depth = 0;
      for (let q = el; q; q = q.parentElement) depth += 1;
      cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    cands.sort((a, b) => b.depth - a.depth);
    return cands[0] || null;
  }, label);
  if (nav) {
    await page.mouse.click(nav.x, nav.y);
    await page.waitForTimeout(2500);
  }
}

// 找「隐私」页签
const privacyNav = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "隐私") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});

let panelText = "";
let switchCount = 0;
if (privacyNav) {
  await page.mouse.click(privacyNav.x, privacyNav.y);
  await page.waitForTimeout(1500);
  panelText = await page.evaluate(() => document.querySelector(".privacy")?.textContent?.trim() ?? "");
  switchCount = await page.evaluate(() => document.querySelectorAll(".privacy .el-switch").length);
}

// ① 应用没被改坏
check("应用正常加载（无 JS 报错）", errors.length === 0, errors.slice(0, 2).join(" | "));
check("隐私面板可见", panelText.length > 0, panelText.slice(0, 60));

// ② 出站请求里零遥测
const bad = requests.filter(u => /telemetry|toonflow\.net/i.test(u));
check("出站请求零 telemetry / toonflow", bad.length === 0, `共 ${requests.length} 个请求，命中 ${bad.length} 个${bad[0] ? `：${bad[0]}` : ""}`);

// ③ 隐私面板如实说明、且没有失效开关
check("隐私面板说明不收集数据", /不收集|不上传/.test(panelText), panelText.slice(0, 80));
check("隐私面板已无失效的数据收集开关", switchCount === 0, `el-switch 数量 = ${switchCount}`);

await browser.close();

const passed = results.filter(r => r.ok).length;
console.log(`\n结果：${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
