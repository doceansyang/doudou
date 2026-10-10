/**
 * 打开已出片的对话，递归（含 shadow DOM）dump 「你的视频生成好了」附近的页面结构，
 * 找出成片到底挂在什么元素上、数据走什么请求。
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

const seen: string[] = [];
page.on("response", (res) => {
  const url = res.url();
  const ct = String(res.headers()["content-type"] || "");
  if (/video|mp4|m3u8|octet-stream|media/i.test(ct + url) && !/\.(png|jpg|jpeg|webp|svg)/i.test(url)) {
    seen.push(`${res.status()} ${ct.slice(0, 40)} ${url.slice(0, 160)}`);
  }
});

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

// 打开最近一条视频对话
const title = page.getByText("橘猫春日暖阳视频生成").first();
if (await title.count()) {
  await title.click({ timeout: 8000 }).catch(() => undefined);
  console.log("已打开对话");
}
await page.waitForTimeout(6000);
// 滚到底
await page.mouse.wheel(0, 4000);
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const out: any = { media: [], custom: [], shadowHosts: 0, canvas: [] };

  const walk = (root: any, depth: number) => {
    if (!root || depth > 12) return;
    const all: Element[] = Array.from(root.querySelectorAll("*"));
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const cls = String(el.className || "").slice(0, 70);
      const rect = el.getBoundingClientRect();
      if (/video|media|player/i.test(tag + " " + cls) && rect.width > 100) {
        out.media.push({ tag, cls, w: Math.round(rect.width), h: Math.round(rect.height), html: String(el.outerHTML).slice(0, 300) });
      }
      if (tag.includes("-") && rect.width > 100) {
        out.custom.push({ tag, cls, w: Math.round(rect.width) });
      }
      if (tag === "canvas" && rect.width > 100) {
        out.canvas.push({ cls, w: Math.round(rect.width), h: Math.round(rect.height) });
      }
      if ((el as any).shadowRoot) {
        out.shadowHosts += 1;
        walk((el as any).shadowRoot, depth + 1);
      }
    }
  };
  walk(document, 0);

  // 「你的视频生成好了」附近的结构
  const marker = Array.from(document.querySelectorAll("*")).find((el) =>
    (el.textContent || "").includes("你的视频生成好了") && el.children.length <= 2,
  );
  let around = "";
  if (marker) {
    let node: Element | null = marker;
    for (let i = 0; i < 6 && node?.parentElement; i += 1) node = node.parentElement;
    around = String(node?.outerHTML || "").slice(0, 2500);
  }
  return { ...out, around };
});

console.log("\n含 video/media/player 的元素:");
for (const item of info.media.slice(0, 12)) console.log(" ", JSON.stringify(item));
console.log("\ncanvas:");
for (const item of info.canvas.slice(0, 8)) console.log(" ", JSON.stringify(item));
console.log("\n自定义元素（含 -）:");
for (const item of info.custom.slice(0, 12)) console.log(" ", JSON.stringify(item));
console.log("\nshadowRoot 数:", info.shadowHosts);
console.log("\n=== 「你的视频生成好了」外层结构 ===\n", info.around);
console.log("\n=== 媒体相关响应 ===\n" + (seen.slice(-15).join("\n") || "（无）"));

await context.close();
