// Dola 页面诊断：站点能不能正常渲染、登录态探针能给出什么结论、有没有崩溃/报错。
//
// 为什么要单独一个探针：Dola 是海外站点，页面结构与国内不同，
// 绑定账号时的「登录态判定」和生成时的「控件定位」都要靠它先探明。
// 浏览器启动参数与生产一致（同样的真实窗口 + 标记），否则探出来的结论不代表性。
//
// 用法：bun scripts/_probe-dola-page.ts [dola|doubao]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const platform = process.argv[2] === "doubao" ? "doubao" : "dola";
const url = platform === "dola" ? "https://www.dola.com/chat" : "https://www.doubao.com/";
// 第三个参数可传代理（形如 http://127.0.0.1:7897），用于验证「走代理能否绕过地区限制」
const proxy = process.argv[3] ?? "";
const profileDir = resolve(tmpdir(), `jinyutv-page-probe-${platform}${proxy ? "-proxy" : ""}`);

const lines: string[] = [];
const log = (text: string) => {
  const line = `${new Date().toISOString().slice(11, 19)}  ${text}`;
  lines.push(line);
  console.log(line);
};

await mkdir(profileDir, { recursive: true });
log(`平台=${platform}  url=${url}`);
log(`profile=${profileDir}`);

// 与生产一致：必须显式指定系统 Chrome/Edge，否则 Playwright 会去找它自带的
// Chromium（本机没装，直接报错），探出来的结论就不代表真实运行情况。
const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
const localAppData = process.env.LOCALAPPDATA ?? "";
const executablePath = [
  `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
  `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
  `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
].find((candidate) => existsSync(candidate));
log("浏览器：" + (executablePath ?? "（没找到，将用 Playwright 自带）"));
if (proxy) log("代理：" + proxy);

const { chromium } = await import("playwright");
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : {}),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1280, height: 820 },
  args: [
    "--window-position=80,60", "--window-size=1280,860", "--toonflow-rpa=1",
    ...(proxy ? [`--proxy-server=${proxy}`] : []),
  ],
});

const page = context.pages()[0] ?? (await context.newPage());
let crashed = false;
page.on("crash", () => {
  crashed = true;
  log("!! 页面崩溃（renderer crash）");
});
page.on("pageerror", (error: any) => log("pageerror: " + String(error).slice(0, 180)));
page.on("requestfailed", (request: any) => {
  const failure = request.failure();
  log(`请求失败: ${String(request.url()).slice(0, 90)} — ${failure?.errorText ?? "?"}`);
});
page.on("console", (message: any) => {
  if (message.type() === "error") log("console.error: " + String(message.text()).slice(0, 160));
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  log("已到达 domcontentloaded");
  await page.waitForTimeout(4000);

  // 隔离实验：openLogin 里比诊断探针多出的唯一一步就是「用 CDP 改窗口尺寸」。
  // 传 resize 就复刻这一步，看崩溃是不是它引起的。
  if (process.argv.includes("resize")) {
    log("执行 CDP setWindowBounds（复刻 revealBrowserWindow）…");
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 80, top: 60, width: 1440, height: 900 },
    });
    log("已改窗口尺寸 1440x900");
  }

  await page.waitForTimeout(12000);
  if (!crashed) {
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyLength: document.body?.innerText?.length ?? 0,
      loginText: /登录|log\s*in|sign\s*in/i.test((document.body?.innerText ?? "").slice(0, 4000)),
      // 复刻生产里的 Dola 登录态探针，直接看它在真实页面上给出什么
      avatarNodes: document.querySelectorAll(
        '[data-testid="chat_header_avatar_button"],[data-testid*="user-avatar"],'
        + '[data-testid*="user-menu"],[aria-label*="Account" i],[aria-label*="Profile" i]',
      ).length,
      cornerAvatars: Array.from(document.querySelectorAll('[class*="avatar"]')).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left < 300 && (rect.top < 140 || rect.bottom > innerHeight - 140);
      }).length,
    }));
    log("页面信息：" + JSON.stringify(info));
  }
  const cookies = await context.cookies([url]);
  log("cookie 名称：" + JSON.stringify(cookies.map((item: any) => item.name).slice(0, 25)));
} catch (error) {
  log("!! 异常：" + String(error).split("\n")[0]);
} finally {
  await context.close().catch(() => undefined);
  log(`profile 已创建：${existsSync(profileDir)}`);
}
