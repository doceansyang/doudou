/**
 * 验证：给 Playwright 启动的浏览器加自定义命令行标记，是否一切正常。
 *
 * 背景：JinyuTV 桌面端要靠 `--toonflow-rpa=1` 这个命令行标记，用 WMI 认出
 * 「这是我方 RPA 拉起的浏览器」，从而把窗口收编进软件内的「豆包窗口」侧栏。
 * 风险点是：Playwright 是否原样透传未知开关、Chrome 是否会因此启动失败。
 *
 * 跑法：cd toonflow && bun scripts/_probe-rpa-mark.ts
 */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARK = "--toonflow-rpa";
const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "rpa-mark-"));

console.log("profile =", profile);

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: EXE,
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1200, height: 800 },
  args: ["--window-position=80,60", "--window-size=1200,800", MARK + "=1", "--no-first-run"],
});

console.log("✓ 浏览器已启动，页面数 =", ctx.pages().length);

const ps = [
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\"",
  `| Where-Object { $_.CommandLine -like '*${MARK}*' }`,
  "| Select-Object ProcessId, CommandLine | Format-List",
].join(" ");
const out = Bun.spawnSync(["powershell", "-NoProfile", "-Command", ps]);
const text = new TextDecoder().decode(out.stdout).trim();

console.log("---- WMI 按标记查询结果 ----");
console.log(text || "(空：没查到带标记的进程)");

const hit = text.includes(MARK);
console.log(hit ? "✓ 标记生效：软件能认出这个浏览器" : "✗ 标记未生效");

await ctx.close();
console.log("已关闭，Done");
