/**
 * 助手浮窗定位回归探针
 *
 * 要回答的问题（用户 2026-10-10 反馈）：
 *   小窗口时浮窗在右侧，窗口最大化后跑到中间 —— 能不能自动回右侧？
 *
 * 做法：把视口设成「小窗口 → 最大化 → 再缩小」，每次读 #agentPanel 的
 * 真实矩形（boundingBox），用「右边缘差 = 视口宽 - 面板右边缘」做判据。
 * **必须用 boundingBox 判定**，看截图会被缩放误导（项目记忆里的教训）。
 *
 * 两种模式都要测：
 *   ① 停靠（docked）—— 期望右边缘差恒为 0
 *   ② 悬浮（floating）—— 期望「原本贴右的，窗口变化后仍贴右」
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = join(process.cwd(), "scripts", "_out");
const lines: string[] = [];
const log = (text: string) => {
  lines.push(text);
  console.log(text);
};

const SIZES: Array<[string, number, number]> = [
  ["小窗口   1280x800", 1280, 800],
  ["最大化   1920x1080", 1920, 1080],
  ["超宽     2560x1200", 2560, 1200],
  ["缩回小窗 1280x800", 1280, 800],
];

/** 传函数体而不是字符串：Playwright 对字符串形式会当表达式求值，导致拿到 undefined。 */
function measure() {
  const el = document.querySelector("#agentPanel");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    docked: el.classList.contains("docked"),
    left: Math.round(r.left),
    top: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
    right: Math.round(r.right),
    bottom: Math.round(r.bottom),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

/** 右边缘差：0 = 贴右；>0 = 离右边还有距离 */
const rightGap = (m: any) => m.vw - m.right;

async function run(browser: any, docked: boolean) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log(`  [pageerror] ${String(e.message).split("\n")[0]}`));

  // 预先写入用户的模式偏好（模拟用户点过停靠/切换按钮）
  await page.addInitScript(
    ([want]: [string]) => {
      try { localStorage.setItem("toonflow.agentDocked", want); } catch { /* 无痕模式 */ }
    },
    [docked ? "1" : "0"] as [string],
  );

  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  // 面板用 v-show，点工作台左上角的助手按钮打开（按钮的 aria-label 是 "JinyuTV Agent"）
  const opened = await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>("button[aria-controls='agentPanel']");
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(1200);
  const visible = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("#agentPanel");
    return !!el && getComputedStyle(el).display !== "none";
  });
  log(`  （助手按钮点击=${opened} 面板可见=${visible}）`);

  log("");
  log(`===== ${docked ? "停靠模式" : "悬浮模式"} =====`);
  const rows: Array<{ label: string; gap: number; top: number; h: number; docked: boolean }> = [];
  for (const [label, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const m = await page.evaluate(measure);
    if (!m) {
      log(`  ${label}: !! 没找到 #agentPanel`);
      continue;
    }
    const gap = rightGap(m);
    rows.push({ label, gap, top: m.top, h: m.h, docked: m.docked });
    log(
      `  ${label}  面板 left=${String(m.left).padStart(5)} w=${String(m.w).padStart(4)} top=${String(m.top).padStart(4)} h=${String(m.h).padStart(4)}` +
        `  右边缘差=${String(gap).padStart(5)}px  ${m.docked ? "docked" : "floating"}`,
    );
  }

  // 判据：最大化的那一步，右边缘差必须为 0（贴右）
  const maximized = rows.find((r) => r.label.includes("最大化"));
  await page.screenshot({ path: join(OUT, `agent-panel-${docked ? "docked" : "floating"}.png`) });
  await context.close();

  if (!maximized) return false;
  if (docked) {
    const worst = Math.max(...rows.map((r) => r.gap));
    log(`  → 停靠模式最大右边缘差 ${worst}px  ${worst <= 1 ? "✓ 始终贴右" : "✗ 有漂移"}`);
    return worst <= 1;
  }
  // 判据：右边缘差在全程必须保持稳定（贴右的浮窗不该随窗口变宽而漂离右侧）
  const first = rows[0].gap;
  const worst = Math.max(...rows.map((r) => Math.abs(r.gap - first)));
  log(`  → 悬浮模式：右边缘差全程 ${first}px ±${worst}px  ${worst <= 2 ? "✓ 贴右得以保持" : "✗ 最大化后脱离右侧"}`);
  return worst <= 2;
}

const browser = await (await import("playwright")).chromium.launch({
  executablePath: CHROME,
  headless: true,
});
try {
  const a = await run(browser, true);
  const b = await run(browser, false);
  log("");
  log(`结论：${a && b ? "两种模式都贴右 ✓" : "存在漂移，需修"}`);
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync(join(OUT, "agent-panel-probe.log"), lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
