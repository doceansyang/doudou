// 验证「没装 Chrome 时用 Edge 兜底」这条路是否真的可行：
// 用 playwright 的 executablePath 指向系统 Edge，看能否正常启动并打开页面。
import { chromium } from "playwright";

const candidates = [
  "C://Program Files (x86)//Microsoft//Edge//Application//msedge.exe",
  "C://Program Files//Microsoft//Edge//Application//msedge.exe",
];

let exe: string | undefined;
for (const c of candidates) {
  const { existsSync } = await import("node:fs");
  if (existsSync(c)) { exe = c; break; }
}
if (!exe) { console.log("SKIP 本机没有 Edge"); process.exit(0); }

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.goto("https://www.doubao.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
console.log("OK Edge 启动成功，页面标题 =", await page.title());
await browser.close();
