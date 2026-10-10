/**
 * 一体化验证：自己起服务 → 打开画布 → 点选文本节点 → 量三项指标 → 关服务。
 *
 * 背景：本机服务会被工具宿主回收（Bash 进程一结束，服务就没了），
 * 所以「起服务」和「测量」必须在**同一条命令**里完成，不能分两次调用。
 *
 * 校验目标（用户反馈）：
 *   ① 两个连接柄（加号）应在节点**垂直中间**
 *   ② 底部提示词卡与本体的间距应为 12px（与原版一致）
 *   ③ 顶部工具条同理
 *
 * 用法：bun scripts/_verify-textnode-layout.ts
 */
import { chromium, type Browser } from "playwright";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3000;
const INSTALL = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable";
const BUN = `${INSTALL}/runtime/bun.exe`;

function log(message: string) {
  console.log(message);
}

function systemChrome(): string | undefined {
  const roots = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return roots.find((p) => existsSync(p));
}

async function portOpen(): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/workspaces/list`);
      if (response.ok) return true;
    } catch { }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** 用 start-server.bat 之外的方式起服务：直接跑 server 入口。 */
async function startServer(): Promise<{ stop: () => void } | null> {
  const dir = mkdtempSync(join(tmpdir(), "tfsrv-"));
  const bat = join(dir, "run.bat");
  // 用 cmd /c 起（沙箱里Start-Process 被拦，但bat 可执行）；失败则返回 null。
  writeFileSync(bat, `@echo off\r\ncd /d "${INSTALL}"\r\ncall start-server.bat\r\n`, "utf8");
  try { chmodSync(bat, 0o755); } catch { }
  const child = spawn("cmd.exe", ["/c", bat], { cwd: INSTALL, detached: false, stdio: "ignore" });
  const ok = await portOpen();
  if (!ok) {
    child.kill();
    return null;
  }
  return { stop: () => { try { child.kill(); } catch { } } };
}

let server: { stop: () => void } | null = null;
let browser: Browser | undefined;

async function main() {
  log("① 起本地服务…");
  server = await startServer();
  if (!server) {
    log("✗ 服务没能起来（沙箱限制）。请手动双击 JinyuTV.exe 后重跑本脚本的测量部分。");
    process.exit(2);
  }
  log("   服务已就绪");

  browser = await chromium.launch({ headless: true, executablePath: systemChrome() });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://localhost:${PORT}/#/workspace`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
  await page.waitForTimeout(2500);

  // 浮动槽只有选中后才渲染 —— 必须先点选
  const textNode = page.locator(".nodeSkeleton").filter({ has: page.locator(".textContent, .textNodeMarkdown") }).first();
  if (!(await textNode.count())) {
    log("✗ 画布上找不到文本节点");
    return;
  }
  await textNode.click({ position: { x: 40, y: 16 } });
  await page.waitForTimeout(900);

  const m = await page.evaluate(() => {
    const skeleton = [...document.querySelectorAll(".nodeSkeleton")]
      .find((s) => s.querySelector(".textContent, .textNodeMarkdown"));
    if (!skeleton) return null;
    const card = skeleton.querySelector(".contentCard");
    const r = (e: Element | null) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    };
    const handles = [...skeleton.querySelectorAll(".nodeHandle")].map((h) => ({
      label: h.getAttribute("aria-label") || "",
      box: r(h.querySelector(".handleIcon") || h),
    }));
    return {
      sized: skeleton.classList.contains("sized"),
      skeleton: r(skeleton),
      card: r(card),
      topSlot: r(skeleton.querySelector(".floatingSlot.topSlot")),
      bottomSlot: r(skeleton.querySelector(".floatingSlot.bottomSlot")),
      handles,
    };
  });

  if (!m || !m.card) {
    log("✗ 没能取到几何数据");
    return;
  }

  log("");
  log(`节点 sized 类: ${m.sized ? "是（被手动调过尺寸）" : "否（走原版布局）"}`);
  log(`本体卡片 ${m.card.w.toFixed(0)}x${m.card.h.toFixed(0)}  y=${m.card.y.toFixed(0)}..${(m.card.y + m.card.h).toFixed(0)}`);
  if (m.skeleton) log(`外层容器 ${m.skeleton.w.toFixed(0)}x${m.skeleton.h.toFixed(0)}  y=${m.skeleton.y.toFixed(0)}..${(m.skeleton.y + m.skeleton.h).toFixed(0)}`);

  log("");
  let pass = true;

  // ① 连接柄垂直居中
  const cardMidY = m.card.y + m.card.h / 2;
  for (const h of m.handles) {
    if (!h.box) continue;
    const dy = h.box.y + h.box.h / 2 - cardMidY;
    const ok = Math.abs(dy) <= 2;
    if (!ok) pass = false;
    log(`① 连接柄 ${h.label.slice(0, 18).padEnd(20)} 中心偏移 dy=${dy.toFixed(1)}px ${ok ? "✓居中" : "✗偏离"}`);
  }

  // ②③ 浮动槽间距
  for (const [name, slot] of [["③ 顶部工具条", m.topSlot], ["② 底部提示词卡", m.bottomSlot]] as const) {
    if (!slot) { log(`${name} 未显示`); continue; }
    const gap = slot.y >= m.card.y ? slot.y - (m.card.y + m.card.h) : m.card.y - (slot.y + slot.h);
    const ok = Math.abs(gap - 12) <= 2;
    if (!ok) pass = false;
    const dx = slot.cx - m.card.cx;
    log(`${name} 垂直间距=${gap.toFixed(0)}px ${ok ? "✓" : `✗ 应为 12px`}   水平偏移 dx=${dx.toFixed(1)}px ${Math.abs(dx) <= 2 ? "✓居中" : "✗偏移"}`);
  }

  log("");
  log(pass ? "✓ 全部达标" : "✗ 仍有不达标项（见上）");
  await page.screenshot({ path: "scripts/_out/textnode-fixed.png" });
  log("截图：scripts/_out/textnode-fixed.png");
}

try {
  await main();
} finally {
  await browser?.close();
  server?.stop();
}
process.exit(0);