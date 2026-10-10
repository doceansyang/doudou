/**
 * 一体化验收：起服务 → 打开画布 → 同时验证「视频是否显示」与「文本节点是否原版」。
 *
 * 背景：服务会被工具宿主回收，起服务与测量必须同一条命令完成。
 *
 * 校验项：
 *   ① 视频：box 必须非 0（曾出现 0x0 整块不可见）；
 *      竖屏/横屏的左右留白都必须 <= 2px。
 *   ② 文本节点：不得再有 sized/resize 痕迹；点选后连接柄应居中、
 *      底部提示词卡距卡片 12px。
 *
 * 用法：bun scripts/_verify-all.ts
 */
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3000;
const INSTALL = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable";

function log(m: string) { console.log(m); }

function systemChrome(): string | undefined {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => existsSync(p));
}

async function portOpen(): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/workspaces/list`)).ok) return true; } catch { }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

let browser: Browser | undefined;
let server: { stop: () => void } | null = null;

try {
  log("① 起服务…");
  const child = spawn("cmd.exe", ["/c", "start-server.bat"], { cwd: INSTALL, stdio: "ignore" });
  if (!(await portOpen())) { log("✗ 服务没起来，请手动双击 JinyuTV.exe"); process.exit(2); }
  server = { stop: () => { try { child.kill(); } catch { } } };
  log("   已就绪");

  browser = await chromium.launch({ headless: true, executablePath: systemChrome() });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/#/workspace`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
  await page.waitForTimeout(2500);

  let pass = true;

  // ---------- ① 视频 ----------
  const videos = await page.evaluate(() =>
    [...document.querySelectorAll("video")].map((v) => {
      const r = v.getBoundingClientRect();
      const vw = v.videoWidth, vh = v.videoHeight;
      const scale = vw && vh ? Math.min(r.width / vw, r.height / vh) : 0;
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        vw, vh, loaded: vw > 0 && vh > 0,
        pad: Math.round((r.width - vw * scale) / 2),
        ratio: vw && vh ? +(vw / vh).toFixed(3) : 0,
      };
    }));

  log("");
  log(`① 视频：共 ${videos.length} 个`);
  if (!videos.length) {
    log("   ✗ 画布上没有 video 元素");
    pass = false;
  }
  for (const [i, v] of videos.entries()) {
    const vis = v.w > 0 && v.h > 0;
    const noPad = v.pad <= 2;
    if (!vis || !noPad) pass = false;
    log(`   #${i} ${v.ratio < 0.95 ? "竖屏" : "横屏"} ${v.ratio} box=${v.w}x${v.h} ${v.loaded ? "已加载" : "未加载"} 留白=${v.pad}px  ${vis ? "✓可见" : "✗尺寸为0"} ${noPad ? "✓无留白" : "✗有留白"}`);
  }

  // ---------- ② 文本节点 ----------
  const tn = page.locator(".nodeSkeleton").filter({ has: page.locator(".textContent, .textNodeMarkdown") }).first();
  if (await tn.count()) {
    await tn.click({ position: { x: 40, y: 16 } });
    await page.waitForTimeout(800);
  }
  const node = await page.evaluate(() => {
    const s = [...document.querySelectorAll(".nodeSkeleton")].find((x) => x.querySelector(".textContent, .textNodeMarkdown"));
    if (!s) return null;
    const r = (e: Element | null) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; };
    return {
      hasResize: !!s.querySelector(".nodeResizeHandle"),
      sized: s.classList.contains("sized"),
      card: r(s.querySelector(".contentCard")),
      top: r(s.querySelector(".floatingSlot.topSlot")),
      bottom: r(s.querySelector(".floatingSlot.bottomSlot")),
      handles: [...s.querySelectorAll(".nodeHandle")].map((h) => ({ label: h.getAttribute("aria-label") || "", box: r(h.querySelector(".handleIcon") || h) })),
    };
  });

  log("");
  if (node?.card) {
    log("② 文本节点");
    const clean = !node.hasResize && !node.sized;
    if (!clean) pass = false;
    log(`   resize 手柄: ${node.hasResize ? "✗ 仍存在" : "✓ 已移除"}   sized 类: ${node.sized ? "✗ 仍触发" : "✓ 无"}`);
    const mid = node.card.y + node.card.h / 2;
    for (const h of node.handles) {
      if (!h.box) continue;
      const dy = h.box.y + h.box.h / 2 - mid;
      const ok = Math.abs(dy) <= 2;
      if (!ok) pass = false;
      log(`   连接柄 ${h.label.slice(0, 16).padEnd(18)} dy=${dy.toFixed(1)}px ${ok ? "✓居中" : "✗偏离"}`);
    }
    if (node.bottom) {
      const gap = node.bottom.y - (node.card.y + node.card.h);
      const ok = Math.abs(gap - 12) <= 3;
      if (!ok) pass = false;
      log(`   底部提示词卡间距 ${gap.toFixed(0)}px ${ok ? "✓" : "✗"}`);
    }
  } else {
    log("② 文本节点：画布上未找到");
  }

  if (errors.length) log(`\n页面错误 ${errors.length} 条：\n  ${errors.slice(0, 3).join("\n  ")}`);
  log("");
  log(pass ? "✓ 全部达标" : "✗ 仍有不达标项");
  await page.screenshot({ path: "scripts/_out/verify-all.png" });
} finally {
  await browser?.close();
  server?.stop();
}
process.exit(0);