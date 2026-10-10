/**
 * 探针：竖屏（9:16）视频在节点里的留白实测。
 *
 * 用户反馈 9:16 视频两侧留白，横屏正常。怀疑是
 * `.videoPreview { width:100%; max-height:240px; object-fit:contain }`：
 * 竖屏视频按宽度铺开后高度超过 240px → 被 max-height 压回 → object-fit:contain
 * 于是**宽度方向留出黑边**。
 *
 * 本探针量：video 元素的盒子尺寸 + 内部可见画面尺寸（videoWidth/videoHeight 与
 * 按 contain 计算出的实际显示矩形），算出四周黑边各多少像素。
 *
 * 用法：bun scripts/_probe-video-fit.ts
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

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

const browser = await chromium.launch({ headless: true, executablePath: systemChrome() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 60000 });
try {
  await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
} catch {
  log("画布上没有节点");
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(2000);

const rows = await page.evaluate(() => {
  function box(element: Element) {
    const r = element.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  return [...document.querySelectorAll("video")].map((video, index) => {
    const rect = box(video);
    const style = getComputedStyle(video);
    const vw = (video as HTMLVideoElement).videoWidth;
    const vh = (video as HTMLVideoElement).videoHeight;
    // object-fit:contain 下，实际画面在盒子里的尺寸
    const scale = Math.min(rect.w / vw, rect.h / vh);
    const shownW = vw * scale;
    const shownH = vh * scale;
    return {
      index,
      srcTail: (video.getAttribute("src") || "").split("/").pop()?.slice(0, 40) || "",
      boxW: Math.round(rect.w),
      boxH: Math.round(rect.h),
      videoW: vw,
      videoH: vh,
      ratio: vw && vh ? (vw / vh).toFixed(3) : "0",
      objectFit: style.objectFit,
      maxHeight: style.maxHeight,
      padLeft: Math.round((rect.w - shownW) / 2),
      padTop: Math.round((rect.h - shownH) / 2),
      loaded: vw > 0 && vh > 0,
      readyState: (video as HTMLVideoElement).readyState,
    };
  });
});

if (!rows.length) {
  log("画布上没有<video> 元素");
} else {
  log(`共${rows.length} 个 video\n`);
  log("序号比例box(w x h)      画面留白(左右/上下)  object-fit  max-height  加载");
  for (const r of rows) {
    const orientation = !r.loaded ? "?" : Number(r.ratio) < 0.95 ? "竖屏" : "横屏";
    log(
      `#${r.index} ${orientation} ${r.ratio}  ${String(r.boxW).padStart(4)}x${String(r.boxH).padStart(3)}` +
      `      ${String(r.padLeft).padStart(3)} / ${String(r.padTop).padStart(3)}` +
      `     ${r.objectFit.padEnd(11)} ${r.maxHeight.padEnd(10)} ${r.loaded ? "已加载" : `rs=${r.readyState}`}`,
    );
  }

  const bad = rows.filter((r) => r.loaded && r.padLeft > 2);
  if (bad.length) {
    log(`\n有 ${bad.length} 个 video 左右留白 > 2px：`);
    for (const r of bad) log(`  #${r.index} 比例 ${r.ratio} 左右各 ${r.padLeft}px（box ${r.boxW}x${r.boxH}，视频 ${r.videoW}x${r.videoH}）`);
  } else {
    log("\n所有已加载的 video 左右留白都 <= 2px");
  }
}

await page.screenshot({ path: "scripts/_out/video-fit.png" });
log("\n截图：scripts/_out/video-fit.png");
await browser.close();