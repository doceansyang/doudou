/** 定位发送按钮的属性（id / aria-label / title / class）。 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HOME = "https://www.doubao.com/";
const PROFILE = resolve(homedir(), ".toonflow-doubao-profile");

const { chromium } = await import("playwright");
const executable = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
const context = await chromium.launchPersistentContext(PROFILE, { ...(executable ? { executablePath: executable } : {}), headless: false, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

const newChat = page.getByRole("button", { name: /^\s*新对话/ });
for (let i = 0; i < Math.min(await newChat.count(), 6); i += 1) {
  try { if (await newChat.nth(i).isVisible()) { await newChat.nth(i).click({ timeout: 5000 }); break; } } catch { /* continue */ }
}
await page.waitForTimeout(2500);

const chip = await page.evaluate(() => {
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const hit = Array.from(document.querySelectorAll("button, [role='button']"))
    .filter(visible)
    .map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.x + r.width / 2, y: r.y + r.height / 2, t: (el.textContent || "").trim() }; })
    .find((item) => item.t === "视频生成" && item.y > 700);
  return hit ? { x: Math.round(hit.x), y: Math.round(hit.y) } : null;
});
if (chip) { await page.mouse.click(chip.x, chip.y); await page.waitForTimeout(5000); }

const editor = page.locator("textarea:visible, [contenteditable='true']:visible").last();
await editor.click();
await editor.fill("一只橘猫在洒满阳光的木地板上伸懒腰");
await page.waitForTimeout(2500);

const buttons = await page.evaluate(() => {
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll("button, [role='button'], [id]"))
    .filter(visible)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id || "",
        cls: String(el.className).slice(0, 60),
        aria: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 16),
        disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true",
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })
    .filter((item) => item.y > 580 && item.x > 1150);
});
console.log("右下角可点元素（含 id 的）：");
for (const b of buttons) console.log(JSON.stringify(b));

await context.close();
