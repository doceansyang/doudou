/**
 * 探针：量「视频框」与「视频本身」的尺寸差（用户要求：多大的视频就多大的框）。
 *
 * 用户截图里三个视频节点的框都比视频大、两侧留空。
 * 本探针对每个视频节点输出：
 *   卡片（含 padding）→ 内容区 → 播放器容器 → video 元素本身
 * 逐层对比宽度，**找出第一个让宽度变大的环节**。
 *
 * 用法：bun scripts/_probe-video-box.ts
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

function log(m: string) { console.log(m); }

function systemChrome(): string | undefined {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => existsSync(p));
}

import { spawn } from "node:child_process";

/** 一体化：自己起服务再量，避免服务被工具宿主回收。 */
async function ensureServer() {
  for (let i = 0; i < 5; i++) {
    try { if ((await fetch("http://127.0.0.1:3000/api/workspaces/list")).ok) return null; } catch { }
    await new Promise((r) => setTimeout(r, 800));
  }
  const child = spawn("cmd.exe", ["/c", "start-server.bat"], {
    cwd: "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable", stdio: "ignore",
  });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3000/api/workspaces/list")).ok) return child; } catch { }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return child;
}
const server = await ensureServer();
const browser = await chromium.launch({ headless: true, executablePath: systemChrome() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  function r(el: Element | null) {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
  }
  return [...document.querySelectorAll(".nodeSkeleton")]
    .filter((s) => s.querySelector("video"))
    .map((s, i) => {
      const card = s.querySelector(".contentCard");
      const body = s.querySelector(".contentCard .el-card__body");
      const content = s.querySelector(".videoContent, .clipContent");
      const player = s.querySelector(".videoPlayer");
      const video = s.querySelector("video") as HTMLVideoElement | null;
      const cardBox = r(card);
      const bodyBox = r(body);
      const contentBox = r(content);
      const playerBox = r(player);
      const videoBox = r(video);
      return {
        i,
        label: s.querySelector(".labelText")?.textContent?.trim() || "",
        natural: video ? `${video.videoWidth}x${video.videoHeight}` : "-",
        ratio: video?.videoWidth && video.videoHeight
          ? +(video.videoWidth / video.videoHeight).toFixed(3) : 0,
        card: cardBox, body: bodyBox, content: contentBox, player: playerBox, video: videoBox,
        // 竖向留白：卡片比视频宽多少（横向）
        hGap: cardBox && videoBox ? +(cardBox.w - videoBox.w).toFixed(1) : 0,
        // 横向留白：卡片比视频高多少
        vGap: cardBox && videoBox ? +(cardBox.h - videoBox.h).toFixed(1) : 0,
        loaded: !!video?.videoWidth,
      };
    });
});

if (!rows.length) {
  log("画布上没有视频节点（可能需要横向拖动画布）");
} else {
  log(`共 ${rows.length} 个视频节点`);
  log("（卡片宽度 = 视频宽度 + 左右各 8px 内边距 + 边框 = +18，属正常）\n");
  for (const r of rows) {
    const orient = r.ratio && r.ratio < 0.95 ? "竖屏" : "横屏";
    // 判定：卡片宽 - 视频宽 应≈ 18（内边距），否则说明框比视频宽了
    const hOk = Math.abs(r.hGap - 18) <= 3;
    log(`──── #${r.i} ${r.label}  ${orient} ${r.ratio}  原始 ${r.natural}`);
    log(`   卡片 ${r.card?.w}x${r.card?.h}  cardBody ${r.body?.w}  content ${r.content?.w}x${r.content?.h}  player ${r.player?.w}x${r.player?.h}  video ${r.video?.w}x${r.video?.h}`);
    log(`   → 横向余量 ${r.hGap}px（期望≈18）${hOk ? "✓ 框与视频吻合" : "✗ 框比视频宽"}   纵向余量 ${r.vGap}px（卡片略高属正常）`);
    log("");
  }
}

await page.screenshot({ path: "scripts/_out/video-box.png" });
log("截图：scripts/_out/video-box.png");
await browser.close();
try { server?.kill(); } catch {}
