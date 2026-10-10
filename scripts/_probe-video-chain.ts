/**
 * 探针：定位竖屏视频左右留白的**真正来源**。
 *
 * 已知：.videoPreview 已是 width:auto、.videoPlayer 已是 inline-flex，
 * 但竖屏 720x1280 的视频盒子仍是 111x148（比例 0.75 ≠ 0.563）→ 左右各 14px。
 * 说明盒子宽度不是由视频自身决定的，而是被**某个祖先的宽度**限定。
 *
 * 本探针沿DOM 链逐级打印实际宽度，找到第一个把宽度压窄的元素。
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
await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  const videos = [...document.querySelectorAll("video")];
  const portrait = videos.find((v) => {
    const r = v.getBoundingClientRect();
    return v.videoWidth > 0 && v.videoHeight > 0 && v.videoWidth / v.videoHeight < 0.95;
  }) as HTMLVideoElement | undefined;
  if (!portrait) return { found: false, total: videos.length };

  const chain: unknown[] = [];
  let element: Element | null = portrait;
  while (element && chain.length < 14) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    chain.push({
      tag: element.tagName.toLowerCase(),
      cls: (element.className || "").toString().slice(0, 80),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      width: style.width,
      maxWidth: style.maxWidth,
      minWidth: style.minWidth,
      display: style.display,
      objectFit: style.objectFit,
      // 谁给它设了行内宽度（节点宽度是 style绑定的）
      inline: (element as HTMLElement).getAttribute("style")?.slice(0, 120) || "",
    });
    element = element.parentElement;
  }

  const vw = portrait.videoWidth;
  const vh = portrait.videoHeight;
  const rect = portrait.getBoundingClientRect();
  const scale = Math.min(rect.width / vw, rect.height / vh);
  return {
    found: true,
    video: { vw, vh, ratio: +(vw / vh).toFixed(3) },
    box: { w: Math.round(rect.width), h: Math.round(rect.height), ratio: +(rect.width / rect.height).toFixed(3) },
    padLeft: Math.round((rect.width - vw * scale) / 2),
    chain,
  };
});

if (!result.found) {
  log("画布上没有竖屏视频");
} else {
  log(`视频原始 ${result.video.vw}x${result.video.vh}（比例 ${result.video.ratio}）`);
  log(`显示盒子 ${result.box.w}x${result.box.h}（比例 ${result.box.ratio}）  左右留白各 ${result.padLeft}px\n`);
  log("沿 DOM 链向上（第一个把宽度压窄的就是真凶）：");
  log("宽".padEnd(6) + "高".padEnd(6) + "元素".padEnd(22) + "class".padEnd(38) + "width / max-width / display");
  for (const row of result.chain as Record<string, string>[]) {
    log(
      String(row.w).padEnd(6) +
      String(row.h).padEnd(6) +
      row.tag.padEnd(22) +
      row.cls.padEnd(38) +
      `${row.width} / ${row.maxWidth} / ${row.display}`,
    );
    if (row.inline) log(`      ↳ 行内 style: ${row.inline}`);
  }
}

await browser.close();