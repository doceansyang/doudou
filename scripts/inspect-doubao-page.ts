/**
 * 勘察豆包页面结构：逐步打开流程并输出每一步的可见文本与截图，
 * 用于在豆包改版后重新校准选择器。
 *
 *   bun run scripts/inspect-doubao-page.ts
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HOME = "https://www.doubao.com/";
const PROFILE = resolve(homedir(), ".toonflow-doubao-profile");
const OUT = resolve(import.meta.dir, "..", "assets", "doubao-inspect");

const RE_WELCOME = /有什么我能帮你(?:的)?吗[？?]?\s*$|^\s*How can I (?:assist|help) you today\?\s*$/i;
const RE_NEW_CHAT = /^\s*(?:新对话|New Chat)\s*$/i;
const RE_VIDEO_ENTRY = /视频生成|生成视频|AI\s*视频|AI\s*创作|图片生成视频|Create Videos|Generate Videos|Video Generation|AI\s*Creation/i;
const RE_MODEL = /Seedance\s*2(?:\.0)?\s*Fast/i;

await mkdir(OUT, { recursive: true });

const { chromium } = await import("playwright");
const executable = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((path) => existsSync(path));

const context = await chromium.launchPersistentContext(PROFILE, {
  ...(executable ? { executablePath: executable } : {}),
  headless: false,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

async function dump(label: string) {
  const info = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const texts = Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], a"))
      .filter(visible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 60);
    const inputs = Array.from(document.querySelectorAll("textarea, input, [contenteditable='true']"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        placeholder: (el as HTMLInputElement).placeholder || "",
        accept: (el as HTMLInputElement).accept || "",
        multiple: (el as HTMLInputElement).multiple || false,
      }));
    return {
      url: location.href,
      title: document.title,
      body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 700),
      texts,
      inputs,
      hasVideo: document.querySelectorAll("video").length,
      seedanceMatches: (document.body.innerText || "").match(/Seedance[^\n]{0,20}/gi) || [],
    };
  });
  console.log(`\n===== ${label} =====`);
  console.log("url   :", info.url);
  console.log("标题  :", info.title);
  console.log("正文  :", info.body.slice(0, 400));
  console.log("按钮  :", JSON.stringify(info.texts.slice(0, 26)));
  console.log("输入  :", JSON.stringify(info.inputs));
  console.log("Seedance 命中:", JSON.stringify(info.seedanceMatches.slice(0, 5)));
  await page.screenshot({ path: resolve(OUT, `${label}.png`), fullPage: false }).catch(() => undefined);
  return info;
}

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);
await dump("01-home");

// 新对话
try {
  await page.locator("body").press("Escape");
} catch { /* ignore */ }
const newChat = page.getByRole("button", { name: RE_NEW_CHAT });
let clickedNewChat = false;
for (let i = 0; i < Math.min(await newChat.count(), 8); i += 1) {
  try {
    if (await newChat.nth(i).isVisible()) {
      await newChat.nth(i).click({ timeout: 5000 });
      clickedNewChat = true;
      break;
    }
  } catch { /* continue */ }
}
console.log("\n新对话按钮命中:", clickedNewChat);
await page.waitForTimeout(2500);
await dump("02-new-conversation");
console.log("欢迎页就绪:", (await page.getByText(RE_WELCOME).count()) > 0);

// 视频生成入口
const entry = page.getByText(RE_VIDEO_ENTRY);
console.log("\n视频生成候选数:", await entry.count());
for (let i = 0; i < Math.min(await entry.count(), 10); i += 1) {
  const item = entry.nth(i);
  const visible = await item.isVisible().catch(() => false);
  const text = visible ? await item.innerText().catch(() => "") : "";
  console.log(`  [${i}] visible=${visible} text=${JSON.stringify(String(text).slice(0, 30))}`);
  if (visible) {
    try {
      await item.click({ timeout: 4000 });
      await page.waitForTimeout(2000);
      break;
    } catch { /* continue */ }
  }
}
await dump("03-after-entry-click");
console.log("Seedance 命中数:", await page.getByText(RE_MODEL).count());

await page.waitForTimeout(1500);
await dump("04-final");

await context.close();
console.log("\n截图目录:", OUT);
