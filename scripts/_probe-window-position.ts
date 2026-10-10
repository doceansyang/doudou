/**
 * 验证：豆包 RPA 的浏览器窗口是否真的开在【屏幕内】。
 *
 * 用法：用与 doubao-rpa-core.ts 完全相同的启动参数拉起 Chrome，
 *      通过 CDP 读回窗口坐标，判断是否落在可见区域。
 *
 * 判据：left/top 必须为正且小于屏幕尺寸；不能是 -32000 那类"屏幕外"坐标。
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const NAV_ARGS = ["--window-position=80,60", "--window-size=1440,900"];

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

// 用一个临时 profile，避免打扰用户已登录的豆包账号
const profile = `${homedir()}\\.toonflow-doubao-profile-positiontest`;

const browser = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
  args: process.platform === "win32" ? NAV_ARGS : [],
});

const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto("about:blank");

const session = await browser.newCDPSession(page);
const { windowId } = await session.send("Browser.getWindowForTarget");
const { bounds } = await session.send("Browser.getWindowBounds", { windowId });

const screenInfo = await page.evaluate(() => ({ w: screen.availWidth, h: screen.availHeight }));

const onScreen = (bounds.left ?? -99999) > -1000 && (bounds.top ?? -99999) > -1000
  && (bounds.left ?? 0) < screenInfo.w && (bounds.top ?? 0) < screenInfo.h;

console.log("启动参数        :", NAV_ARGS.join(" "));
console.log("窗口坐标        :", JSON.stringify(bounds));
console.log("屏幕可用区域    :", JSON.stringify(screenInfo));
console.log("是否在屏幕内    :", onScreen ? "✓ 是（用户能看到）" : "❌ 否（任务栏可见、屏幕上看不到）");

await browser.close();
console.log("已关闭测试浏览器");
process.exit(onScreen ? 0 : 1);
