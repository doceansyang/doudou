/**
 * 精确探针：底栏「视频生成」模式芯片点击后会变成什么，以及模型选择器在哪。
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HOME = "https://www.doubao.com/";
const PROFILE = resolve(homedir(), ".toonflow-doubao-profile");
const OUT = resolve(import.meta.dir, "..", "assets", "doubao-inspect");
await mkdir(OUT, { recursive: true });

const { chromium } = await import("playwright");
const executable = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
const context = await chromium.launchPersistentContext(PROFILE, { ...(executable ? { executablePath: executable } : {}), headless: false, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] ?? (await context.newPage());

async function toolbar() {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const chips = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { t: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 18), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })
      .filter((item) => item.t && item.y > 560);
    return chips;
  });
}

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

// 新对话：可访问名带快捷键后缀，用前缀匹配
const newChat = page.getByRole("button", { name: /^\s*新对话/ });
for (let i = 0; i < Math.min(await newChat.count(), 6); i += 1) {
  try {
    if (await newChat.nth(i).isVisible()) { await newChat.nth(i).click({ timeout: 5000 }); break; }
  } catch { /* continue */ }
}
await page.waitForTimeout(2500);
console.log("底栏（新对话后）:", JSON.stringify(await toolbar()));

// 用鼠标坐标点「视频生成」芯片
const chips = await toolbar();
const videoChip = chips.find((c) => c.t.includes("视频生成"));
console.log("视频生成芯片:", JSON.stringify(videoChip));
if (videoChip) {
  await page.mouse.click(videoChip.x, videoChip.y);
  await page.waitForTimeout(5000);
}
await page.screenshot({ path: resolve(OUT, "05-video-mode.png") });

const state = await page.evaluate(() => {
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return {
    bottomText: Array.from(document.querySelectorAll("button, [role='button'], span"))
      .filter(visible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => /Seedance|视频|模型|比例|时长|s$/.test(t))
      .slice(0, 40),
    bodyTail: (document.body.innerText || "").replace(/\s+/g, " ").slice(-500),
    inputs: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).filter(visible)
      .map((el) => ({ tag: el.tagName.toLowerCase(), ph: (el as HTMLInputElement).placeholder || "", accept: (el as HTMLInputElement).accept || "" })),
    videos: document.querySelectorAll("video").length,
  };
});
console.log("\n=== 点视频生成后 ===");
console.log("含关键词文本:", JSON.stringify(state.bottomText));
console.log("正文尾部   :", state.bodyTail);
console.log("输入控件   :", JSON.stringify(state.inputs));
console.log("video 元素 :", state.videos);

await page.waitForTimeout(3000);
await page.screenshot({ path: resolve(OUT, "06-video-mode-final.png") });
const late = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").match(/Seedance[^\n]{0,24}/gi) || []);
console.log("稍后 Seedance 命中:", JSON.stringify(late));

await context.close();
console.log("截图:", OUT);
