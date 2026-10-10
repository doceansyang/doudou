/**
 * 打开已生成视频的对话，dump <video> 元素的真实结构与可用的下载入口，
 * 用于校准「成片抓取」这一步。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HOME = "https://www.doubao.com/";
const PROFILE = resolve(homedir(), ".toonflow-doubao-profile");

const { chromium } = await import("playwright");
const executable = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
const context = await chromium.launchPersistentContext(PROFILE, { ...(executable ? { executablePath: executable } : {}), headless: false, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] ?? (await context.newPage());

const mediaResponses: { url: string; ct: string; len: number }[] = [];
page.on("response", async (res) => {
  try {
    const ct = String(res.headers()["content-type"] || "");
    if (/video\/|application\/octet-stream/i.test(ct)) {
      mediaResponses.push({ url: String(res.url()).slice(0, 200), ct, len: Number(res.headers()["content-length"] || 0) });
    }
  } catch { /* ignore */ }
});

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

// 点开侧栏里那条视频对话
const target = page.getByText("橘猫春日暖阳视频生成").first();
if (await target.count()) {
  await target.click({ timeout: 8000 }).catch(() => undefined);
  console.log("已打开视频对话");
} else {
  console.log("未在侧栏找到该对话，尝试点『最近』第一条");
}
await page.waitForTimeout(5000);

const dump = async (label: string) => {
  const info = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll("video"));
    return {
      count: videos.length,
      items: videos.map((el: any) => ({
        outer: String(el.outerHTML).slice(0, 500),
        currentSrc: el.currentSrc || "",
        src: el.src || el.getAttribute("src") || "",
        poster: el.poster || "",
        dataSrc: el.getAttribute("data-src") || "",
        sources: Array.from(el.querySelectorAll("source")).map((s: any) => s.src || s.getAttribute("src") || ""),
        readyState: el.readyState,
        duration: Number.isFinite(el.duration) ? el.duration : null,
      })),
      videoButtons: Array.from(document.querySelectorAll("button, [role='button']"))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            aria: el.getAttribute("aria-label") || "",
            title: el.getAttribute("title") || "",
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 14),
            y: Math.round(r.y + r.height / 2),
            x: Math.round(r.x + r.width / 2),
          };
        })
        .filter((item) => /下载|分享|保存|Download|Share/i.test(item.aria + item.title + item.text)),
      anchors: Array.from(document.querySelectorAll("a[href]"))
        .map((el: any) => el.href)
        .filter((href: string) => /mp4|video|download/i.test(href))
        .slice(0, 8),
    };
  });
  console.log(`\n===== ${label} =====`);
  console.log("video 数:", info.count);
  for (const [i, item] of info.items.entries()) {
    console.log(`  [${i}] currentSrc=${item.currentSrc.slice(0, 120)}`);
    console.log(`      src=${item.src.slice(0, 120)}  poster=${item.poster.slice(0, 100)}  dataSrc=${item.dataSrc.slice(0, 100)}`);
    console.log(`      sources=${JSON.stringify(item.sources.slice(0, 3))}  readyState=${item.readyState} duration=${item.duration}`);
    console.log(`      outer=${item.outer.slice(0, 260)}`);
  }
  console.log("下载/分享按钮:", JSON.stringify(info.videoButtons));
  console.log("含视频的链接:", JSON.stringify(info.anchors));
  console.log("video 响应:", JSON.stringify(mediaResponses.slice(-6)));
};

await dump("01-刚打开");
// 试着让它加载：点一下视频
const box = await page.locator("video").first().boundingBox().catch(() => null);
if (box) {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(6000);
  await dump("02-点击视频后");
}

await context.close();
