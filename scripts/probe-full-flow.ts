/**
 * 全流程探针：视频模式 → 传参考图 → 填提示词 → 找发送按钮 → 点击 → 观察反馈。
 * 目的是一次性把选择器全部校准。
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

/** 底栏（y>560）所有可点元素的文本与坐标 */
async function bottomBar() {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          t: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24),
          aria: el.getAttribute("aria-label") || "",
          disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true",
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      })
      .filter((item) => item.y > 560);
  });
}

async function files() {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll("input[type='file']")).map((el) => ({
      accept: (el as HTMLInputElement).accept,
      multiple: (el as HTMLInputElement).multiple,
      visible: visible(el),
    }));
  });
}

async function editors() {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll("textarea, [contenteditable='true'], input[type='text']"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        ph: (el as HTMLInputElement).placeholder || el.getAttribute("data-placeholder") || "",
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
      }));
  });
}

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

const newChat = page.getByRole("button", { name: /^\s*新对话/ });
for (let i = 0; i < Math.min(await newChat.count(), 6); i += 1) {
  try { if (await newChat.nth(i).isVisible()) { await newChat.nth(i).click({ timeout: 5000 }); break; } } catch { /* continue */ }
}
await page.waitForTimeout(2500);

// 进视频模式（按坐标点芯片）
let chips = await bottomBar();
const videoChip = chips.find((c) => c.t === "视频生成");
if (videoChip) { await page.mouse.click(videoChip.x, videoChip.y); await page.waitForTimeout(5000); }
console.log("=== 视频模式底栏 ===");
console.log(JSON.stringify(await bottomBar()));
console.log("文件输入:", JSON.stringify(await files()));
console.log("编辑控件:", JSON.stringify(await editors()));

// 点 ＋ 看是否弹文件选择框
chips = await bottomBar();
const plus = chips.find((c) => c.t === "+" || c.t === "＋" || c.aria.includes("上传") || c.aria.includes("附件"));
console.log("\n＋ 按钮:", JSON.stringify(plus));
if (plus) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  await page.mouse.click(plus.x, plus.y);
  const chooser = await chooserPromise;
  console.log("弹出文件选择框:", chooser ? "✓ 是" : "✗ 否");
  if (chooser) {
    // 1x1 透明 PNG，仅用于验证上传通道
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await chooser.setFiles([{ name: "probe.png", mimeType: "image/png", buffer: png }]);
    await page.waitForTimeout(6000);
    console.log("上传后截图…");
    await page.screenshot({ path: resolve(OUT, "07-after-upload.png") });
  } else {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(OUT, "07-after-plus.png") });
    console.log("点击后文件输入:", JSON.stringify(await files()));
  }
}

// 填提示词
const edit = (await editors())[0];
console.log("\n编辑控件:", JSON.stringify(edit));
if (edit) {
  const box = page.locator("textarea:visible, [contenteditable='true']:visible").last();
  await box.click();
  await box.fill("一只橘猫在洒满阳光的木地板上伸懒腰，暖色调，治愈风格");
  await page.waitForTimeout(2500);
}
console.log("填词后底栏:", JSON.stringify(await bottomBar()));
await page.screenshot({ path: resolve(OUT, "08-after-prompt.png") });

await context.close();
console.log("截图:", OUT);
