/**
 * 诊断「设置 → 文本模型」里三颗按钮点了没反应：
 *   编辑 / 添加供应商 / 添加自定义供应商
 * 三颗都指向「打开弹窗」，所以要么是事件没触发，要么是弹窗组件加载失败。
 *
 * 做法：打开设置 → 文本模型 → 逐颗点击，同时抓 console / pageerror，
 * 并检查 .el-dialog 是否真的出现（含可见性、尺寸、标题）。
 *
 * 跑法：cd toonflow && bun scripts/_probe-settings-buttons.ts
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

page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") log(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => log(`[pageerror] ${String(e.message).split("\n")[0]}`));
page.on("response", (r) => { if (r.status() >= 400) log(`[HTTP ${r.status()}] ${r.url()}`); });
page.on("requestfailed", (r) => log(`[请求失败] ${r.url()} — ${r.failure()?.errorText}`));

/** 弹窗现状：数量、可见性、标题、尺寸 */
const DIALOG_STATE = `(() => {
  const ds = [...document.querySelectorAll(".el-dialog")];
  return JSON.stringify({
    count: ds.length,
    items: ds.map((d) => {
      const cs = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      const wrap = d.closest(".el-overlay");
      return {
        title: (d.querySelector(".el-dialog__title") || {}).textContent || "",
        w: Math.round(r.width), h: Math.round(r.height),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        overlay: wrap ? getComputedStyle(wrap).display : "(无 overlay)",
      };
    }),
  });
})()`;

async function clickAndCheck(label: string, locator: () => ReturnType<typeof page.locator>) {
  log("");
  log(`===== 点击「${label}」 =====`);
  const el = locator();
  const n = await el.count();
  if (!n) { log("  !! 找不到这颗按钮"); return; }
  const btn = el.first();
  const box = await btn.boundingBox();
  log(`  按钮盒子: ${box ? `${Math.round(box.width)}x${Math.round(box.height)} @(${Math.round(box.x)},${Math.round(box.y)})` : "不可见"}`);
  const info = await btn.evaluate((b) => {
    const cs = getComputedStyle(b);
    return { disabled: (b as HTMLButtonElement).disabled, pointerEvents: cs.pointerEvents, display: cs.display, visibility: cs.visibility };
  });
  log(`  按钮状态: disabled=${info.disabled} pointer-events=${info.pointerEvents} display=${info.display} visibility=${info.visibility}`);

  // 关键：用 elementFromPoint 看这个坐标最上层到底是谁 —— 能直接抓出「被遮挡」
  if (box) {
    const top = await page.evaluate(
      ({ x, y }) => {
        const e = document.elementFromPoint(x, y);
        if (!e) return "(null)";
        const tag = e.tagName.toLowerCase();
        const cls = (e.className && typeof e.className === "string") ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
        const inBtn = !!e.closest("button");
        return `${tag}${cls} 是否落在按钮内=${inBtn}`;
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    log(`  该坐标最上层元素: ${top}`);
  }

  await btn.click({ timeout: 4000 }).catch((e) => log(`  click 抛错：${String(e.message).split("\n")[0]}`));
  await page.waitForTimeout(2500);

  const state = JSON.parse(String(await page.evaluate(DIALOG_STATE)));
  log(`  点击后弹窗数量=${state.count}`);
  for (const d of state.items) log(`    「${d.title}」 ${d.w}x${d.h} display=${d.display} visibility=${d.visibility} opacity=${d.opacity} overlay=${d.overlay}`);

  if (state.count) {
    // 关掉，避免影响下一次判断
    await page.locator(".el-dialog__headerbtn").first().click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1200);
  }
}

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(4000);

  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1200);

  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(2000);

  log("=== 进入 设置 → 文本模型 ===");
  log(`  供应商卡片数: ${await page.locator(".providerItem").count()}`);

  await clickAndCheck("添加供应商", () => page.locator(".providerActions .addButton").first());
  await clickAndCheck("添加自定义供应商", () => page.locator(".providerActions .addButton").nth(1));
  await clickAndCheck("编辑", () => page.locator(".providerItem .itemActions button").filter({ hasText: "编辑" }));

  await page.screenshot({ path: "assets/_settings-buttons.png" });
  log("");
  log("截图：assets/_settings-buttons.png");
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_settings-buttons.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
