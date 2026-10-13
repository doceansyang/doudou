import type { GenerateMedia, MediaAsset, VideoRequest } from "@toonflow/providers";
import { createDecipheriv, createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ACCOUNT_PLATFORMS, normalizeAccountType, type AccountType } from "./doubao-accounts.ts";
import { compareForWatermark } from "./doubao-watermark.ts";

/**
 * 豆包账号（免费额度）视频生成 —— Toonflow 供应商实现。
 *
 * 走豆包网页版而非官方 API：用户在自己浏览器里扫码登录一次，之后每日免费额度由账号本身提供。
 * 生成流程移植自 JinyuTV（CDTV）里已实测跑通的 Playwright RPA。
 *
 * 2026-10-09 按当前豆包页面结构重新校准过的关键点（务必保留，改版时优先查这里）：
 *   - 侧栏「新对话」按钮的可访问名带快捷键后缀（“新对话Ctrl Shift K”），只能前缀匹配；
 *   - 「视频生成」是输入框底栏的模式芯片，用 getByText().click() 点不动，
 *     必须取它的包围盒坐标后用鼠标点；
 *   - 进入视频模式后底栏变成：＋ | 视频生成 | 模型 Seedance 2.0 Mini | 自动 · 10s | 发送（id=flow-end-msg-send）；
 *   - 参考图走隐藏的 input[type=file]（accept=.jpg,.png,.jpeg,.webp,.apng，multiple=true），
 *     可以直接 setInputFiles，不需要触发系统文件选择框；
 *   - 发送键 id 固定为 flow-end-msg-send，但要等它 enabled 后再点。
 *
 * 关键约束：豆包风控识别无头浏览器，headless 下登录会话不被认可，因此始终开真实窗口；
 * 窗口始终开在屏幕内，用户可随时查看；需要扫码或人工验证时会自动置顶。
 */

const version = "1.1.0";

/**
 * 浏览器窗口标记（命令行开关）。
 *
 * 早先版本用它让桌面端 WMI 扫出浏览器窗口、SetParent 收编进软件侧栏。
 * 用户反馈「在侧栏与全屏之间来回乱跳，反而更难用」，**收编已整体移除**，
 * 桌面端不再碰这个窗口；这里保留标记只作调试识别之用（浏览器会忽略它）。
 */
const RPA_WINDOW_MARK = "--toonflow-rpa=1";

/** 豆包首页（默认平台）；Dola 走 homeUrlOf()。 */
const HOME = ACCOUNT_PLATFORMS.doubao.url;

/**
 * 平台入口地址。豆包与 Dola 是同一族但**不同域**的两个站点：
 * 登录页、生成页、cookie 判据、页面控件全部按平台分开，
 * 混用会把国内凭证发到海外站点（或反过来），所以处处显式传 accountType。
 */
function homeUrlOf(accountType?: string): string {
  return ACCOUNT_PLATFORMS[normalizeAccountType(accountType)].url;
}

function platformLabel(accountType?: string): string {
  return ACCOUNT_PLATFORMS[normalizeAccountType(accountType)].label;
}

/**
 * 地区受限检查。
 *
 * Dola 会按访问地区拦截，命中后由页面 JS 跳到
 * `https://www.dola.com/security/region-restricted`（HTML 里没有文案，纯 JS 跳转）。
 * 不主动识别的话，用户看到的是一个空白窗口 + 一直等登录（首次实测：对着空白页干等），
 * 所以这里一发现就抛出可操作的提示。
 */
async function assertPlatformAccessible(page: any, accountType?: string): Promise<void> {
  const current = String(page?.url?.() || "");
  if (!current.includes("/security/region-restricted")) return;
  const label = platformLabel(accountType);
  throw new Error(
    `${label} 提示「当前地区不可用」：请确认网络能访问海外站点`
    + `（例如代理节点位于允许的地区）后重试。当前地址：${current}`,
  );
}
/** 登录态与浏览器 profile 的落盘位置，跨任务复用。 */
const PROFILE_ROOT = resolve(homedir(), ".toonflow-doubao-profile");
/** 单次生成的墙钟上限：视频通常 1～3 分钟，超过即判超时。 */
const TIMEOUT_MS = 20 * 60 * 1000;
/** 结果轮询间隔。 */
const POLL_MS = 2000;
/** 登录等待上限。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 触发人工安全验证后，等用户手动完成的时限。 */
const CAPTCHA_WAIT_MS = 5 * 60 * 1000;
/** 输入框底栏（模式芯片 / 模型 / 比例时长 / 发送键）的纵坐标下界。 */
const COMPOSER_Y = 580;

/* ------------------------------------------------------------------ 文案匹配 */

/** 空对话欢迎语，用于确认「新对话确实开出来了」，避免复用上一轮会话误判出片。 */
/**
 * 新对话就绪判据。
 *
 * ⚠️ 不要锚定结尾、也不要只认一句话：实测同一台机器上，
 * 个人版欢迎语是「有什么我能帮你的吗？」，而企业工作台是「今天有什么工作要处理？」。
 * 这里只做宽匹配，真正的「能不能用」由 isEnterpriseWorkspace 单独判定并给出明确错误。
 */
const RE_WELCOME = /有什么我能帮你(?:的)?吗|今天有什么工作要处理|How can I (?:assist|help) you today/i;
/** 企业版工作台（豆包「工作」空间）的特征；它没有视频生成能力。 */
const RE_ENTERPRISE_WORKSPACE = /新工作任务|云电脑|企业知识|更多技能|和豆包工作的对话/;
/** 注意必须前缀匹配：真实可访问名是「新对话Ctrl Shift K」。 */
const RE_NEW_CHAT = /^\s*新对话|^\s*New Chat/i;
/** 视频模式芯片的可点文案。 */
const VIDEO_MODES = ["视频生成", "生成视频", "图片生成视频", "AI 视频", "Create Videos", "Video Generation"];
const RE_SEEDANCE = /Seedance/i;
const RE_RATIO_DURATION = /(自动|Auto|3:4|4:3|9:16|16:9|1:1|21:9)\s*[·・]\s*\d+\s*s/i;
const RE_UPLOAD_IMAGE = /上传图片|上传参考图|添加图片|选择图片|参考图|Upload (?:image|photo)|Add (?:image|photo)|Reference image/i;
const RE_SEND_NAMED = /^(开始生成|立即生成|生成视频|生成|发送|Generate(?: Video| Image)?|Send|Start generating)$/i;
/**
 * 豆包在真正出片前会先回一条「视频生成参数确认 … 确认后我再开始生成视频」，
 * 必须再补一句确认才会开始。这段文案就是判据。
 */
const RE_CONFIRM_REQUEST = /请回复.{0,40}确认.{0,20}生成|确认(?:之)?后\s*[，,：:]?\s*(?:我(?:们)?)?\s*(?:再|就|将|会|才)*\s*(?:开始)?\s*(?:为你)?\s*生成视频|请先确认|确认后我再开始生成/i;
/** 成片就绪文案。豆包把播放器注入空容器，只有点击后才真正请求 mp4。 */
const RE_VIDEO_READY = /你的视频生成好了|视频生成好了|视频已生成|视频生成完成/;
/** 豆包已接受任务、进入排队/生成中的文案；此时不必再补发确认。 */
const RE_ALREADY_GENERATING = /预计等待|生成中|正在生成|生成好后|排队|已开始生成/;
const RE_DOWNLOAD_DESKTOP = /下载.{0,12}电脑版|电脑版.{0,12}下载|Download (?:the )?Desktop App/i;
const RE_AUTH_MATERIAL = /你在本功能中上传[、，,]?使用的素材[，,]?均已获充分授权/;
const RE_CONFIRM_BUTTON = /^(?:确认|确定|同意|继续生成|确认生成|确定生成)$/;
/** 成片地址可能落在这些域下。 */
const MEDIA_HOSTS = [
  "doubao.com", "douyin.com", "douyinvod.com", "365yg.com",
  "byteoversea.com", "ibytedtos.com", "byteimg.com", "bytegecko.com", "volccdn",
  // Dola（海外）：站点域 + 其视频 CDN（形如 v3-xxx.dola.com）
  "dola.com",
];

/**
 * 诊断日志。
 *
 * ⚠️ **必须同时落盘**，不能只 console.log。
 *    RPA 服务是用 CREATE_NO_WINDOW 无窗口拉起的，stdout 直接丢弃 ——
 *    于是本文件里最关键的几句判定（`已切换模型：X` / `未找到点名型号，已选用页面上的
 *    Seedance 型号` / `沿用当前模型：X`）从来没有任何记录。用户报
 *    「我选了 mini，怎么还是用 fast 生成」时，翻遍日志也查不出走的哪条分支
 *    （2026-10-12 实际踩过，只能靠猜）。
 *
 * 写盘失败绝不能影响生成主流程，所以整体 try/catch 吞掉；
 * 用同步写是为了保证多行日志的顺序（异步追加会交错、把行切碎）。
 */
const LOG_FILE = resolve(process.cwd(), "assets", "doubao-rpa.log");

function log(message: string): void {
  const line = `[${new Date().toISOString()}] [doubaoAccount] ${message}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch { /* 记日志失败不影响生成 */ }
}

/* ------------------------------------------------------------------ 通用工具 */

/**
 * 定位可用的 Chromium 内核浏览器。
 *
 * 必须覆盖 Edge：Windows 10/11 **自带 Edge**，而 Chrome 需要用户自行安装。
 * 只认 Chrome 的话，同事的电脑没装 Chrome 就会直接失败。
 * Edge 与 Chrome 同为 Chromium 内核，Playwright 通过 executablePath 驱动效果一致。
 * 仍可用 DOUBAO_BROWSER 环境变量手工指定（排障用）。
 */
function chromeExecutable(): string | undefined {
  const override = process.env.DOUBAO_BROWSER;
  if (override && existsSync(override)) return override;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      // Chrome（优先：风控策略最宽松）
      join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      local && join(local, "Google\\Chrome\\Application\\chrome.exe"),
      // Edge（Windows 自带，作为必达兜底）
      join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    ].find((path): path is string => Boolean(path) && existsSync(path));
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].find((path) => existsSync(path));
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"]
    .find((path) => existsSync(path));
}

/**
 * 启动持久化浏览器上下文。
 *
 * ⚠️ 绝不能再把窗口放到屏幕外（`--window-position=-32000,-32000`）。
 *    Chrome 会把窗口位置记进 profile：一旦曾经被放到屏幕外，
 *    **之后每次启动都沿用那个坐标**，用户看到的现象就是
 *    「任务栏里能看到这个窗口，屏幕上却怎么都找不到」——
 *    豆包要求扫码授权/人工验证时，用户根本无从操作。
 *    所以这里始终给一个屏幕内的固定初始位置；需要扫码/验证时 revealBrowserWindow()
 *    还会把它摆到屏幕内并置前，保证用户一定找得到、点得到。
 *
 * profileDir 是账号隔离的关键：每个豆包账号一个独立 profile，
 * 登录态互不干扰，才能做到「多账号、额度用尽自动换号」。
 */
async function launchContext(profileDir: string = PROFILE_ROOT) {
  const { chromium } = await import("playwright");
  const executable = chromeExecutable();
  await mkdir(profileDir, { recursive: true });
  const options = {
    ...(executable ? { executablePath: executable } : {}),
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: process.platform === "win32"
      ? ["--window-position=80,60", "--window-size=1440,900", RPA_WINDOW_MARK]
      : [],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, options);
  } catch (error) {
    const message = String(error);
    // 上一次进程没完全退出时，Chrome 会判定「已有实例」并直接退出。
    // 等一会儿再试，避免一次偶发就把该账号判死（实测踩过一次）。
    if (/existing browser session|already in use|ProcessSingleton/i.test(message)) {
      log("浏览器 profile 仍被上一次会话占用，等待后重试…");
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return chromium.launchPersistentContext(profileDir, options);
    }
    throw error;
  }
}

/**
 * 登录态检测。两个平台的判据不同，必须分开：
 *   豆包：只看 sessionid / sessionid_ss —— sid_guard 等辅助 cookie 有效期长达一年，
 *         单独存在不能证明已登录（sessionid 已过期时会被误判成已登录）。
 *   Dola：cookie 判据不可靠（国际版会话标记与国内不同，过期 sessionid 也仍留在 jar 里），
 *         必须看页面上的「登录入口 / 用户头像」，见 detectDolaLoginState。
 */
async function isLoggedIn(context: any, accountType?: string): Promise<boolean> {
  const platform = ACCOUNT_PLATFORMS[normalizeAccountType(accountType)];
  if (platform.key === "dola") {
    try {
      const pages = context.pages();
      const page = pages.find((item: any) => isPlatformPage(item, platform)) ?? pages[0];
      if (!page) return false;
      return (await detectDolaLoginState(page)) === "avatar";
    } catch {
      return false;
    }
  }
  try {
    const cookies = await context.cookies([platform.url]);
    return cookies.some(
      (cookie: any) =>
        (cookie.name === "sessionid" || cookie.name === "sessionid_ss") && String(cookie.value ?? "").trim(),
    );
  } catch {
    return false;
  }
}

/** 当前页是否属于该平台（按域名判，避免把国内凭证发到海外站点）。 */
function isPlatformPage(page: any, platform: { domain: string }): boolean {
  try {
    const host = String(new URL(String(page.url() || "")).hostname || "").toLowerCase();
    return host === platform.domain || host.endsWith(`.${platform.domain}`);
  } catch {
    return false;
  }
}

/**
 * Dola 页面登录状态探针：'login' = 出现登录入口，'avatar' = 已登录，null = 还没渲染出来。
 *
 * 移植自之前那版客户端（comoc-drama-client）的 _detect_login_state，那边实测跑过：
 *   · 登录入口是 Semi Design 按钮，短文案且以「登录 / log in / sign in」开头，
 *     并排除「退出登录 / 已登录 / 登录后…」这类误匹配；
 *   · Dola 的用户入口带 data-testid / aria-label，位置在**左下角** ——
 *     不能沿用国内那套「右上角头像」的判据。
 */
async function detectDolaLoginState(page: any): Promise<"login" | "avatar" | null> {
  try {
    return await page.evaluate(() => {
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.visibility !== "hidden" && style.visibility !== "collapse";
      };

      const loginNodes = Array.from(
        document.querySelectorAll('[class*="semi-button"],button,a,[role="button"]'),
      );
      const loginFound = loginNodes.some((node) => {
        const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
        if (!text || text.length > 12) return false;
        if (!/^(登录|log\s*in|sign\s*in)(\s|$)/i.test(text) && !text.startsWith("登录")) return false;
        if (text.includes("退出") || text.includes("已登录") || text.includes("登录后")) return false;
        return isVisible(node);
      });
      if (loginFound) return "login" as const;

      const userControls = document.querySelectorAll(
        '[data-testid="chat_header_avatar_button"],[data-testid*="user-avatar"],'
        + '[data-testid*="user-menu"],[aria-label*="Account" i],[aria-label*="Profile" i]',
      );
      if (Array.from(userControls).some(isVisible)) return "avatar" as const;

      const avatars = Array.from(
        document.querySelectorAll('[class*="semi-avatar"],img[class*="avatar"],[class*="avatar"]'),
      );
      const hasCornerAvatar = avatars.some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left < 300 && (rect.top < 140 || rect.bottom > innerHeight - 140);
      });
      if (hasCornerAvatar) return "avatar" as const;
      return null;
    });
  } catch {
    return null;
  }
}

/** 把画布传来的媒体转成 Playwright 可直接上传的内存文件。 */
function toUploadFile(input: any, index: number) {
  if (!input) return null;
  const build = (base64: string, mimeType: string) => {
    const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
    return { name: `ref-${index + 1}.${ext}`, mimeType, buffer: Buffer.from(base64, "base64") };
  };
  if (input.type === "base64" && input.data) return build(input.data, input.mimeType || "image/png");
  const matched = /^data:([^;,]+);base64,(.+)$/.exec(String(input.url || ""));
  return matched ? build(matched[2], matched[1]) : null;
}

function fileNameSafe(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/-+/g, "-").slice(0, 60);
}

/** 底栏里按精确文案找可点元素，取其中心坐标后用鼠标点击。 */
async function clickByTextInComposer(page: any, texts: string[]): Promise<boolean> {
  const point = await page.evaluate(
    ([wanted, minY]: [string[], number]) => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const hits = Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], div[role='button']"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: (el.textContent || "").replace(/\s+/g, " ").trim(),
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
        })
        .filter((item) => item.y > minY && wanted.includes(item.text));
      return hits.length ? { x: hits[0].x, y: hits[0].y } : null;
    },
    [texts, COMPOSER_Y],
  );
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

/** 底栏是否已经处于视频模式（出现模型名 Seedance 即视为已进入）。 */
async function inVideoMode(page: any): Promise<boolean> {
  const text = await page
    .evaluate((minY: number) => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return Array.from(document.querySelectorAll("button, [role='button']"))
        .filter(visible)
        .filter((el) => el.getBoundingClientRect().y > minY)
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .join(" | ");
    }, COMPOSER_Y)
    .catch(() => "");
  return RE_SEEDANCE.test(text);
}

/* ------------------------------------------------------------------ 页面动作 */

/** 新对话就绪判据：能看到空会话欢迎语。 */
async function newConversationReady(page: any): Promise<boolean> {
  const items = page.getByText(RE_WELCOME);
  for (let index = 0; index < Math.min(await items.count(), 12); index += 1) {
    try {
      if (await items.nth(index).isVisible()) return true;
    } catch { /* 元素已失效，继续找下一个 */ }
  }
  return false;
}

/**
 * 是否进到了「企业工作台」而不是个人版对话页。
 *
 * 企业工作台（左侧「新工作任务 / 自动任务 / 插件·技能·伙伴 / 云盘」，底部
 * 「云电脑 / 项目 / 企业知识 / 更多技能」）**没有视频生成入口**，
 * 继续往下走只会得到「找不到视频生成入口」这种含糊错误，所以这里提前判定。
 */
async function isEnterpriseWorkspace(page: any): Promise<boolean> {
  // 直接读当前页 body：pageAndFrameText 会遍历所有 frame，某个 frame 取不到文本时
  // 整体会退化成空串，导致漏判（实测踩过）。
  const text = await page
    .evaluate(() => (document.body && document.body.innerText) || "")
    .catch(() => "");
  if (/新工作任务/.test(text) && /云电脑|企业知识|更多技能/.test(text)) return true;
  // 兜底：既没有「新对话」入口，也不是个人版欢迎语，却是工作台欢迎语
  const hasNewChat = (await page.getByRole("button", { name: RE_NEW_CHAT }).count().catch(() => 0)) > 0;
  return !hasNewChat && /今天有什么工作要处理/.test(text);
}

/** 开一个干净的新对话，最多重试 3 轮。 */
async function openNewConversation(page: any): Promise<void> {
  // 先判企业工作台：它既没有「新对话」也没有视频生成，越早报清楚越好。
  if (await isEnterpriseWorkspace(page)) {
    throw new Error(
      "这个豆包账号进入的是「企业工作台」（豆包·工作空间），它没有视频生成功能，所以无法生成。" +
      "请在「设置 → 媒体模型 → 豆包账号」里换绑一个个人版豆包账号 —— 扫码后应能看到「新对话」按钮和底部的「视频生成」。",
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.locator("body").press("Escape");
    } catch { /* 没有可关闭的浮层 */ }

    let clicked = false;
    const byRole = page.getByRole("button", { name: RE_NEW_CHAT });
    for (let index = 0; index < Math.min(await byRole.count(), 8); index += 1) {
      try {
        const button = byRole.nth(index);
        if (!(await button.isVisible())) continue;
        await button.click({ timeout: 5000 });
        clicked = true;
        break;
      } catch { /* 试下一个 */ }
    }
    if (!clicked) clicked = await clickByTextInComposer(page, ["新对话", "New Chat"]);

    // 注意：不能只在「点到了按钮」时才检查就绪 —— 工作台/新版页面可能没有该按钮，
    // 但页面本身已经可以输入（实测这就是识别不到欢迎页的原因之一）。
    if (clicked) await page.waitForTimeout(2500);
    else if (attempt < 2) await page.waitForTimeout(2000);
    if (await newConversationReady(page)) return;
  }
  // 走到这里说明既没就绪、也不是企业工作台 —— 给一句能指导排查的话。
  throw new Error("豆包新对话打开失败：已重试 3 轮，仍未识别到欢迎页（请确认该账号能正常打开豆包对话页）");
}

/** 进入豆包「视频生成」模式：底栏模式芯片必须用坐标点击。 */
async function openVideoCreation(page: any): Promise<void> {
  if (await inVideoMode(page)) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await clickByTextInComposer(page, VIDEO_MODES)) {
      await page.waitForTimeout(4000);
      if (await inVideoMode(page)) return;
    }
    if (attempt < 3) await page.waitForTimeout(1500);
  }
  throw new Error("没有找到豆包「视频生成」入口，请确认页面已进入对话并展示底栏功能芯片");
}

/**
 * 选模型。
 *
 * 豆包当前提供的是「Seedance 2.0 Mini」，而画布侧可能传「Seedance 2.0 Fast」。
 * 因此策略是：只要底栏已经挂着 Seedance 就先用起来；用户点名了某个型号时，
 * 打开模型下拉尝试切换，切不到就沿用当前值而不是让整个任务失败。
 */
async function selectModel(page: any, modelName: string): Promise<void> {
  const current = await currentModelLabel(page);
  if (RE_SEEDANCE.test(current) && current.includes(modelName.replace(/^豆包\s*/, ""))) return;

  // 模型入口：国内页面写作「模型 …」；Dola 的英文页面是「Model」。
  // 只在中文入口不存在时才退到英文写法，避免影响已跑通的国内流程。
  const triggerZh = page.getByText(/^\s*模型\s*/).last();
  const trigger = (await triggerZh.count()) > 0 ? triggerZh : page.getByText(/^\s*Models?\s*$/i).last();
  let opened = false;
  try {
    if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
      await trigger.click({ timeout: 4000 });
      await page.waitForTimeout(800);
      opened = true;
    }
  } catch { /* 下拉打不开就沿用当前模型 */ }

  if (opened) {
    const wanted = page.getByText(modelName.replace(/^豆包\s*/, ""), { exact: false });
    for (let index = (await wanted.count()) - 1; index >= 0; index -= 1) {
      const option = wanted.nth(index);
      try {
        if (await option.isVisible()) {
          await option.click({ timeout: 4000 });
          await page.waitForTimeout(800);
          log(`已切换模型：${modelName}`);
          return;
        }
      } catch { /* 试下一个 */ }
    }
    // 点不到目标型号时挑任意一个 Seedance 选项
    const fallback = page.getByText(RE_SEEDANCE);
    for (let index = (await fallback.count()) - 1; index >= 0; index -= 1) {
      const option = fallback.nth(index);
      try {
        if (await option.isVisible()) {
          await option.click({ timeout: 4000 });
          await page.waitForTimeout(800);
          log("未找到点名型号，已选用页面上的 Seedance 型号");
          return;
        }
      } catch { /* 试下一个 */ }
    }
    await page.locator("body").press("Escape").catch(() => undefined);
  }
  log(`沿用当前模型：${current || "页面默认"}`);
}

/** 读取底栏上的当前模型文案。 */
async function currentModelLabel(page: any): Promise<string> {
  return page
    .evaluate((minY: number) => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const hit = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter(visible)
        .filter((el) => el.getBoundingClientRect().y > minY)
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .find((text) => /模型|Seedance/i.test(text));
      return hit || "";
    }, COMPOSER_Y)
    .catch(() => "");
}

/** 设置画面比例与时长：点「比例 · 时长」入口 → 选比例 → 拖滑块到目标秒数。全程失败软着陆。 */
/**
 * 设置画面比例与时长。
 *
 * 两个平台的控件不是同一套：
 *   豆包 —— 底栏一个「自动 · 10s」芯片，点开是比例选项 + 时长滑块；
 *   Dola —— 中英文页面各自有独立的「比例」「时长」下拉控件（移植自上一版客户端
 *          实测跑通的 _configure_dola_video）。
 * 先按平台走，Dola 分支失败时回落到通用流程（页面改版时至少不会直接失败）。
 */
async function configureVideo(page: any, ratio: string, duration: number, accountType?: string): Promise<void> {
  if (normalizeAccountType(accountType) === "dola") {
    try {
      await configureDolaVideo(page, ratio, duration);
      return;
    } catch (error) {
      log(`按 Dola 的方式设置画面参数失败（${error instanceof Error ? error.message : String(error)}），改用通用流程`);
    }
  }
  const triggers = page.getByText(RE_RATIO_DURATION);
  let opened = false;
  for (let index = (await triggers.count()) - 1; index >= 0; index -= 1) {
    const trigger = triggers.nth(index);
    try {
      if (await trigger.isVisible()) {
        await trigger.click({ timeout: 4000 });
        await page.waitForTimeout(500);
        opened = true;
        break;
      }
    } catch { /* 继续 */ }
  }
  if (!opened) {
    log("未找到「比例 · 时长」入口，沿用页面默认值");
    return;
  }

  const ratioText = ratio === "auto" || ratio === "智能" ? "自动" : ratio;
  const ratioOptions = ratioText === "自动"
    ? page.getByText(/^(?:自动|Auto)$/i)
    : page.getByText(ratioText, { exact: true });
  for (let index = (await ratioOptions.count()) - 1; index >= 0; index -= 1) {
    const option = ratioOptions.nth(index);
    try {
      if (await option.isVisible()) {
        await option.click({ timeout: 4000 });
        await page.waitForTimeout(400);
        break;
      }
    } catch { /* 继续 */ }
  }

  let sliders = page.locator('[role="slider"]:visible, input[type="range"]:visible');
  if ((await sliders.count()) === 0) {
    // 部分版本选完比例会自动收起浮层，需要重新打开才能找到滑块
    for (let index = (await triggers.count()) - 1; index >= 0; index -= 1) {
      try {
        const trigger = triggers.nth(index);
        if (await trigger.isVisible()) {
          await trigger.click({ timeout: 4000 });
          await page.waitForTimeout(400);
          break;
        }
      } catch { /* 继续 */ }
    }
    sliders = page.locator('[role="slider"]:visible, input[type="range"]:visible');
  }
  if ((await sliders.count()) === 0) {
    await page.locator("body").press("Escape").catch(() => undefined);
    log("未找到时长滑块，沿用页面默认时长");
    return;
  }

  const slider = sliders.last();
  try {
    await slider.press("Home", { timeout: 4000 });
    const minimum = Number(await slider.getAttribute("min")) || 4;
    for (let step = 0; step < Math.max(0, duration - minimum); step += 1) {
      await slider.press("ArrowRight", { timeout: 2000 });
    }
  } catch { /* 键盘操作不被支持时保持默认 */ }
  await page.waitForTimeout(350);
  await page.locator("body").press("Escape").catch(() => undefined);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按文案找到并点击一个可见控件（Dola 的比例/时长都是这种下拉）。 */
async function clickVideoSetting(page: any, pattern: RegExp): Promise<boolean> {
  const controls = page.getByText(pattern);
  for (let index = (await controls.count()) - 1; index >= 0; index -= 1) {
    const control = controls.nth(index);
    try {
      if (await control.isVisible()) {
        await control.click({ timeout: 4000 });
        await page.waitForTimeout(350);
        return true;
      }
    } catch { /* 换下一个候选 */ }
  }
  return false;
}

/**
 * Dola 的画面比例与时长。
 *
 * 移植自上一版客户端实测跑通的实现：Dola 中英文页面各有一套独立的
 * 「比例」「时长」下拉控件，跟豆包底栏的「自动 · 10s」芯片不是一套，
 * 所以必须单独走这条路。时长优先用滑块（读 min/max/step 校验是否支持），
 * 没有滑块时退回点具体秒数选项。
 */
async function configureDolaVideo(page: any, ratio: string, duration: number): Promise<void> {
  const ratioNames = "自动|Auto|21:9|16:9|4:3|1:1|3:4|9:16";
  const ratioTrigger = new RegExp(`^(?:比例|Ratio|Aspect ratio|${ratioNames})$`, "i");
  if (!(await clickVideoSetting(page, ratioTrigger))) throw new Error("没有找到 Dola 画面比例设置入口");

  const wanted = /^(?:auto|自动)$/i.test(ratio) ? "自动" : ratio;
  const optionPattern = wanted === "自动"
    ? /^(?:自动|Auto)$/i
    : new RegExp(`^${escapeRegExp(wanted)}$`);
  if (!(await clickVideoSetting(page, optionPattern))) throw new Error(`没有找到画面比例选项：${wanted}`);
  await page.locator("body").press("Escape").catch(() => undefined);

  if (!(await clickVideoSetting(page, /^(?:\d+\s*(?:s|秒)|时长|Duration)$/i))) {
    throw new Error("没有找到 Dola 视频时长设置入口");
  }

  const sliders = page.locator('[role="slider"]:visible, input[type="range"]:visible');
  if (await sliders.count()) {
    const slider = sliders.last();
    const minimum = Number(
      (await slider.getAttribute("min")) ?? (await slider.getAttribute("aria-valuemin")) ?? 4,
    );
    const maximum = Number(
      (await slider.getAttribute("max")) ?? (await slider.getAttribute("aria-valuemax")) ?? 15,
    );
    const step = Number((await slider.getAttribute("step")) ?? 1) || 1;
    const steps = (duration - minimum) / step;
    if (duration < minimum || duration > maximum || !Number.isInteger(steps)) {
      throw new Error(`Dola 当前模型不支持 ${duration} 秒时长（可选 ${minimum}~${maximum} 秒）`);
    }
    await slider.press("Home", { timeout: 4000 });
    for (let index = 0; index < steps; index += 1) {
      await slider.press("ArrowRight", { timeout: 2000 });
    }
  } else if (!(await clickVideoSetting(page, new RegExp(`^${duration}\\s*(?:s|秒)$`, "i")))) {
    throw new Error(`没有找到 Dola 视频时长选项：${duration}s`);
  }
  await page.locator("body").press("Escape").catch(() => undefined);
}

/**
 * 上传参考图。
 *
 * 页面里有一个隐藏的 input[type=file]（accept 含图片、multiple=true），
 * 直接 setInputFiles 最稳，不依赖系统文件选择框。
 */
async function uploadImages(page: any, files: any[]): Promise<void> {
  if (!files.length) return;

  const inputs = page.locator('input[type="file"]');
  const total = await inputs.count();
  for (let index = total - 1; index >= 0; index -= 1) {
    const control = inputs.nth(index);
    try {
      const accept = String((await control.getAttribute("accept")) || "").toLowerCase();
      if (accept && !/image|\.png|\.jpg|\.jpeg|\.webp|\.apng/.test(accept)) continue;
      const multiple = (await control.getAttribute("multiple")) !== null;
      await control.setInputFiles(multiple ? files : [files[0]], { timeout: 20000 });
      await page.waitForTimeout(Math.max(3000, files.length * 1500));
      log(`已上传 ${files.length} 张参考图（multiple=${multiple}）`);
      return;
    } catch { /* 该 input 不可用，换下一个 */ }
  }

  // 退路：点「上传图片」按钮唤起文件选择框
  const buttons = page.getByText(RE_UPLOAD_IMAGE);
  for (let index = 0; index < Math.min(await buttons.count(), 10); index += 1) {
    const button = buttons.nth(index);
    try {
      if (!(await button.isVisible())) continue;
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 4000 }),
        button.click({ timeout: 3000 }),
      ]);
      await chooser.setFiles(files);
      await page.waitForTimeout(Math.max(3000, files.length * 1500));
      return;
    } catch { /* 继续 */ }
  }
  throw new Error("没有找到图片上传控件；请确认当前已进入豆包视频生成模式");
}

/** 填提示词：多候选定位，取最后一个可用的输入控件（当前是 contenteditable 的 div）。 */
async function fillPrompt(page: any, prompt: string): Promise<void> {
  const selectors = [
    '[contenteditable="true"]:visible',
    "textarea:visible",
    'input[placeholder*="描述"]:visible',
    'input[placeholder*="输入"]:visible',
    'input[placeholder*="message" i]:visible',
    'input[placeholder*="describe" i]:visible',
  ];
  for (const selector of selectors) {
    const controls = page.locator(selector);
    for (let index = (await controls.count()) - 1; index >= 0; index -= 1) {
      try {
        await controls.nth(index).fill(prompt, { timeout: 5000 });
        return;
      } catch { /* 继续 */ }
    }
  }
  throw new Error("没有找到提示词输入框");
}

/** 点发送：优先用固定 id，其次按文案，最后扫底栏按钮；最多等 90 秒。 */
async function clickGenerate(page: any): Promise<void> {
  for (let tick = 0; tick < 90; tick += 1) {
    const send = page.locator("#flow-end-msg-send");
    if ((await send.count()) > 0) {
      try {
        const button = send.first();
        if (await button.isVisible()) {
          await button.click({ timeout: 5000 });
          return;
        }
      } catch { /* 继续等按钮可用 */ }
    }

    const named = page.getByRole("button", { name: RE_SEND_NAMED });
    for (let index = (await named.count()) - 1; index >= 0; index -= 1) {
      const button = named.nth(index);
      try {
        if ((await button.isVisible()) && (await button.isEnabled())) {
          await button.click({ timeout: 5000 });
          return;
        }
      } catch { /* 继续 */ }
    }

    const controls = page.locator('button:visible, [role="button"]:visible');
    for (let index = (await controls.count()) - 1; index >= 0; index -= 1) {
      const control = controls.nth(index);
      try {
        const box = await control.boundingBox();
        if (!box || box.y < COMPOSER_Y) continue;
        const label = [
          await control.innerText({ timeout: 1000 }).catch(() => ""),
          await control.getAttribute("aria-label"),
          await control.getAttribute("title"),
        ].filter(Boolean).join(" ");
        if (/开始生成|立即生成|生成视频|^生成$|发送|\b(?:Generate|Send)\b/i.test(label) && (await control.isEnabled())) {
          await control.click({ timeout: 5000 });
          return;
        }
      } catch { /* 继续 */ }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("等待 90 秒后仍没有找到可点击的生成或发送按钮");
}

/* ------------------------------------------------------------------ 风控 / 弹窗处理 */

/** 页面 + 子 frame 的全部可见文本，用于风控判据。 */
async function pageAndFrameText(page: any): Promise<string> {
  const texts: string[] = [];
  let pages: any[] = [];
  try {
    pages = page.context().pages();
  } catch {
    pages = [page];
  }
  for (const current of pages) {
    let frames: any[] = [];
    try {
      frames = current.frames();
    } catch {
      continue;
    }
    for (const frame of frames) {
      try {
        const text = await frame.evaluate(() => document.body?.innerText || "");
        if (text) texts.push(text);
      } catch { /* 跨域 frame 跳过 */ }
    }
  }
  return texts.join("\n");
}

/** 豆包「下载电脑版」推广弹窗，需要主动关掉，否则挡住后续操作。 */
async function visibleDownloadDialog(page: any): Promise<any | null> {
  const selectors = ['[role="dialog"]:visible', ".semi-modal:visible", '[class*="modal"]:visible', '[class*="dialog"]:visible'];
  for (const selector of selectors) {
    try {
      const dialogs = page.locator(selector);
      for (let index = 0; index < Math.min(await dialogs.count(), 12); index += 1) {
        const dialog = dialogs.nth(index);
        if (!(await dialog.isVisible())) continue;
        const text = await dialog.innerText({ timeout: 800 }).catch(() => "");
        if (RE_DOWNLOAD_DESKTOP.test(text)) return dialog;
      }
    } catch { /* 继续 */ }
  }
  return null;
}

async function dismissDownloadDialog(page: any): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = await visibleDownloadDialog(page);
    if (!dialog) return;
    const groups = [
      dialog.locator('button[aria-label*="关闭"], [role="button"][aria-label*="关闭"], button[title*="关闭"], [role="button"][title*="关闭"]'),
      dialog.getByRole("button", { name: /^(?:关闭|取消|暂不|以后再说|Close|Cancel|Not now|Later|×|X)$/i }),
      dialog.locator('[class*="close"]:visible, [class*="Close"]:visible, [class*="xicon"]:visible, [class*="XIcon"]:visible'),
    ];
    let clicked = false;
    for (const group of groups) {
      const total = Math.min(await group.count(), 8);
      for (let index = 0; index < total; index += 1) {
        const control = group.nth(index);
        try {
          if (!(await control.isVisible())) continue;
          await control.click({ timeout: 1500 });
          clicked = true;
          break;
        } catch { /* 继续 */ }
      }
      if (clicked) break;
    }
    if (clicked) {
      await page.waitForTimeout(300);
      if (!(await visibleDownloadDialog(page))) return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(500);
    if (!(await visibleDownloadDialog(page))) return;
  }
}

/**
 * 「素材已获授权」安全确认弹窗。
 *
 * 生成开始前后都可能出现；CDTV 的实测结论是最多连续确认 3 轮，超过则需要人工介入。
 */
async function visibleAuthorizedMaterialDialog(page: any): Promise<any | null> {
  const selectors = ['[role="dialog"]:visible', ".semi-modal:visible", '[class*="modal"]:visible', '[class*="dialog"]:visible'];
  for (const selector of selectors) {
    try {
      const dialogs = page.locator(selector);
      for (let index = 0; index < Math.min(await dialogs.count(), 12); index += 1) {
        const dialog = dialogs.nth(index);
        const text = (await dialog.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, "");
        if (text.includes("安全确认") && RE_AUTH_MATERIAL.test(text)) return dialog;
      }
    } catch { /* 继续 */ }
  }
  return null;
}

async function confirmAuthorizedMaterial(page: any): Promise<boolean> {
  const dialog = await visibleAuthorizedMaterialDialog(page);
  if (!dialog) return false;
  const groups = [
    dialog.locator(".semi-button-primary:visible"),
    dialog.locator('button[class*="primary"]:visible'),
    dialog.locator('[role="button"][class*="primary"]:visible'),
    dialog.locator('button:visible, [role="button"]:visible'),
  ];
  let clicked = false;
  for (const group of groups) {
    const total = Math.min(await group.count(), 12);
    for (let index = 0; index < total; index += 1) {
      const control = group.nth(index);
      try {
        const labels = [
          await control.innerText({ timeout: 500 }).catch(() => ""),
          await control.getAttribute("aria-label"),
          await control.getAttribute("title"),
        ];
        if (!labels.some((label) => RE_CONFIRM_BUTTON.test(String(label || "").trim()))) continue;
        if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
        await control.click({ timeout: 3000 });
        clicked = true;
        break;
      } catch { /* 继续 */ }
    }
    if (clicked) break;
  }
  if (!clicked) return false;
  for (let tick = 0; tick < 20; tick += 1) {
    await page.waitForTimeout(250);
    if (!(await visibleAuthorizedMaterialDialog(page))) return true;
  }
  return false;
}

/** 人机验证外壳（验证码常渲染在 canvas 里，只能按容器特征识别）。 */
/**
 * 把浏览器窗口移到屏幕内并置顶。
 *
 * 需要用户动手时（扫码授权 / 人工安全验证）必须调用它，
 * 否则用户只能看到任务栏图标、屏幕上找不到窗口。
 *
 * 两步分开设：先脱离最小化，再设坐标。部分 Chrome 版本把
 * 「windowState + 坐标」放在同一次调用里会忽略坐标，窗口仍留在原处。
 */
async function revealBrowserWindow(page: any): Promise<boolean> {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 80, top: 60, width: 1440, height: 900 },
    });
    await page.bringToFront().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** 触发人工安全验证时：把窗口交还给用户，等他点完再继续（而不是直接判失败）。 */
async function handleCaptcha(page: any): Promise<void> {
  const revealed = await revealBrowserWindow(page);
  log(
    revealed
      ? "检测到豆包人工安全验证：请在弹出的豆包浏览器窗口里完成验证，最多等 5 分钟…"
      : "检测到豆包人工安全验证：请手动切换到豆包浏览器窗口完成验证（最多等 5 分钟）…",
  );
  const deadline = Date.now() + CAPTCHA_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const surface = await hasCaptchaSurface(page).catch(() => true);
    const reason = await blockReason(page).catch(() => "");
    if (!surface && !/人工安全验证/.test(reason)) {
      log("安全验证已通过，继续生成…");
      return;
    }
  }
  throw new Error("豆包人工安全验证未在 5 分钟内完成，本次任务已停止；在豆包浏览器里完成验证后重新生成即可");
}

async function hasCaptchaSurface(page: any): Promise<boolean> {
  const selector = [
    'iframe[src*="captcha" i]:visible',
    'iframe[src*="verifycenter" i]:visible',
    'iframe[src*="challenge" i]:visible',
    'iframe[title*="验证"]:visible',
    "#captcha_container:visible",
    '[class*="captcha_verify"]:visible',
    '[class*="secsdk-captcha"]:visible',
    '[class*="captcha-container"]:visible',
    '[class*="captchaContainer"]:visible',
  ].join(",");
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

/** 返回「本次生成被拒绝」的面向用户原因；空串表示一切正常。 */
async function blockReason(page: any): Promise<string> {
  const text = (await pageAndFrameText(page)).replace(/\s+/g, "");

  if (await hasCaptchaSurface(page)) {
    return "豆包触发人工安全验证，本次任务已停止；请在弹出的豆包浏览器窗口里完成验证后重新生成";
  }
  if (
    /(?:安全|人机|滑块|图片)验证|请(?:先)?完成(?:人脸|真人|身份)?验证|(?:人脸|真人|身份)?验证后继续|请完成.{0,16}验证|完成验证后|验证通过后/i.test(text)
    || /(?:请|按住).{0,12}(?:拖动|滑动).{0,12}(?:滑块|拼图)/.test(text)
    || /请依次点击|点击图中|请选择.{0,24}(?:图片|图案)/.test(text)
  ) {
    return "豆包触发人工安全验证，本次任务已停止；请在弹出的豆包浏览器窗口里完成验证后重新生成";
  }
  if (
    /疑似包含(?:侵权|违规|侵权\/违规)内容/.test(text)
    || (text.includes("无法返回该内容") && text.includes("换个主题"))
    || (text.includes("生成额度未扣除") && /侵权|违规|内容风险/.test(text))
  ) {
    return "豆包判定生成内容疑似侵权或违规，未返回视频；请更换参考图或主题后重试";
  }
  if (
    text.includes("出于肖像保护考虑")
    || text.includes("暂不支持上传真实人脸素材作为参考")
    || /(?:检测到|图片中|画面中|素材中|参考图中).{0,16}(?:人脸|真人)/.test(text)
    || /(?:人脸|真人).{0,24}(?:无法|不能|不支持|违规|风险|审核未通过|生成失败)/.test(text)
    || /(?:无法|不能|不支持).{0,16}(?:人脸|真人)/.test(text)
  ) {
    return "豆包检测到人脸或真人内容并拒绝生成；请更换不含受限人脸内容的参考图后重试";
  }
  if (/今日视频生成免费次数(?:已)?用完/.test(text)) {
    return "豆包账号今日视频生成免费次数已用完，请切换有可用额度的账号或明日再试";
  }
  if (/(?:创作|生成)(?:次数|额度).{0,8}(?:用完|不足)|额度不足|额度已用完|免费次数已用完/.test(text)) {
    return "豆包账号的视频额度不足，请切换有可用额度的账号后重试";
  }
  if (
    ["登录已过期", "登录过期", "登录已失效", "登录失效", "登录状态已失效", "登录状态失效", "会话已过期", "会话过期", "会话失效", "重新登录", "需要登录", "请先登录", "请登录"]
      .some((hint) => text.includes(hint))
  ) {
    return "豆包账号登录已过期或会话失效，请重新登录后再试";
  }
  if (text.includes("视频生成失败") && text.includes("生成额度未扣除")) {
    return "豆包视频生成失败，本次生成额度未扣除；请重试";
  }
  return "";
}

/** 页面是否已提示成片就绪。 */
function videoReady(text: string): boolean {
  return RE_VIDEO_READY.test(text);
}

/**
 * 催播放：豆包把真正的播放器注入到空容器 `.video-player-*` / `.block-video-*` 里，
 * 只有点一下才会去请求 mp4。所以「等 video 出现」是等不到的，必须主动点。
 */
async function nudgePlayback(page: any): Promise<boolean> {
  const holders = page.locator('[class*="video-player-wrapper"], [class*="block-video"], [class*="video-player"]');
  const total = await holders.count();
  for (let index = total - 1; index >= 0; index -= 1) {
    const box = await holders.nth(index).boundingBox().catch(() => null);
    if (!box || box.width < 80 || box.height < 60) continue;
    try {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    } catch { /* 换下一个容器 */ }
  }
  return false;
}

/* ------------------------------------------------------------------ 结果抓取 */

/** 收集页面上的视频指纹，用来判断「这次确实产出了新视频」。 */
async function videoFingerprints(page: any): Promise<Set<string>> {
  const list: string[] = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("video")).flatMap((node: any) => {
        const source = node.currentSrc || node.src || node.getAttribute("src") || node.poster || "";
        const poster = node.poster || "";
        return [source, poster].filter(Boolean);
      }),
    )
    .catch(() => []);
  return new Set(list);
}

/** 从当前页面上直接抓到可下载的视频地址。 */
async function pageVideoSources(page: any): Promise<string[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("video"))
        .flatMap((node: any) => [node.currentSrc, node.src, node.getAttribute("src"), node.getAttribute("poster")])
        .filter((value: any): value is string => typeof value === "string" && value.startsWith("http")),
    )
    .catch(() => []);
}

/** 从网络证据里挑出最像成片的媒体地址。 */
function pickMediaUrl(urls: string[]): string {
  const scored = urls
    .filter((url) => MEDIA_HOSTS.some((host) => url.includes(host)))
    .map((url) => {
      let score = 0;
      if (/\.mp4(\?|$)/i.test(url)) score += 10;
      if (/video/i.test(url)) score += 4;
      if (/play|download|fplay|get_play/i.test(url)) score += 3;
      if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(url)) score -= 8;
      if (/avatar|icon|logo|emoji/i.test(url)) score -= 6;
      return { url, score };
    })
    .sort((left, right) => right.score - left.score);
  return scored.length && scored[0].score > 0 ? scored[0].url : "";
}

/* ------------------------------------------------- 原片（无水印）解析 */

/**
 * fplay 解密用的 KDF 盐。
 * ⚠️ 与 CDTV（`original_doubao_nomark.py`）里的常量逐字一致，改动会导致解不出地址。
 */
const FPLAY_KDF_SALT =
  "TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==";

/** fplay 的密文与 key_seed 都是 base64url。 */
function base64UrlToBuffer(value: string): Buffer {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

/**
 * 解密 fplay 的媒体地址。
 *
 * 算法照搬 CDTV（`original_doubao_nomark.py` 的 `_decode_fplay_url`）：
 *   key = sha512( sha512(seed) ++ salt ) 的前 16 字节，iv = 同一哈希的 16..32 字节，
 *   AES-128-CBC，PKCS#7 去填充。解密结果不是 http(s) 开头就说明解错了
 *   —— 返回空串让调用方跳过，不抛异常（fplay 里混着非地址字段是常态）。
 */
export function decodeFplayUrl(value: unknown, keySeed: string): string {
  const text = String(value ?? "").replace(/&amp;/g, "&").trim();
  if (!text) return "";
  if (/^https?:\/\//.test(text)) return text;
  try {
    const encrypted = base64UrlToBuffer(text);
    const seed = base64UrlToBuffer(keySeed);
    const ciphertext = encrypted.subarray(4);
    if (seed.length < 32 || !ciphertext.length || ciphertext.length % 16) return "";
    const first = createHash("sha512").update(seed).digest();
    const derived = createHash("sha512")
      .update(Buffer.concat([first, base64UrlToBuffer(FPLAY_KDF_SALT)]))
      .digest();
    const decipher = createDecipheriv(
      "aes-128-cbc",
      derived.subarray(0, 16),
      derived.subarray(16, 32),
    );
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const padding = plain[plain.length - 1];
    const body = padding >= 1 && padding <= 16 ? plain.subarray(0, plain.length - padding) : plain;
    const url = body.toString("utf8").trim();
    return /^https?:\/\//.test(url) ? url : "";
  } catch {
    return "";
  }
}

/**
 * 整理 fplay 请求地址：删掉 `force_fids` / `logo_type` / `codec_type`，再固定 `codec_type=1`。
 * 与 CDTV 的 `_clean_fplay_api_url` 等价 —— 参数不同会拿到不带原片的返回。
 */
export function cleanFplayApiUrl(raw: string): string {
  try {
    const url = new URL(String(raw).replace(/&amp;/g, "&"));
    for (const key of ["force_fids", "logo_type", "codec_type"]) url.searchParams.delete(key);
    url.searchParams.set("codec_type", "1");
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * 从抓回的 mp4 里读出 `comment=vid:vXXXX`。
 *
 * 豆包成片的 video_id 就写在这个元数据标签里，**不需要另外抓**（CDTV 也是这么取的）。
 * 只扫前 512 KiB：这个标签在 moov 里，位置很靠前，全量扫没必要。
 */
export function extractVideoId(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512 * 1024))).toString("latin1");
  const matched = /vid:(v[0-9a-zA-Z]{10,})/.exec(head);
  return matched ? matched[1] : "";
}

/**
 * 用页面自己的 fplay 请求换**无水印原片**地址。
 *
 * 为什么非要走这一步（2026-10-13 实测，别再退回老路）：
 *   · 我们抓网络响应体拿到的是**播放用的水印版**，不是原片；
 *   · `POST /samantha/media/get_play_info` 能通、也返回 `original_media_info.main_url`，
 *     但那个地址仍带 `lr=video_gen_watermark_dyn` —— **依然是水印版**（实测 1,578,983 字节）；
 *     把 lr 改写成 `video_gen_no_watermark` 无效（CDTV 已证同一文件同一 SHA）；
 *   · 真正的原片只在 fplay 的返回里：请求 URL 带 `key_seed` → `video_list` 中
 *     **`logo_type` 为空**的项 → 用 key_seed 解密出的地址**不含 watermark** 才是原片；
 *   · fplay 请求**只在登录态页面真正播放时才出现**（分享页拿不到），所以只能从本次
 *     生成的网络流量里截 —— 那就是下面 `fplayApis` 的用途。
 */
async function resolveOriginalViaFplay(
  context: any,
  candidates: string[],
): Promise<{ url: string; definition: string; label: string } | null> {
  const found: { url: string; definition: string; label: string; area: number }[] = [];
  for (const raw of candidates) {
    const api = cleanFplayApiUrl(raw);
    if (!api || !api.includes("key_seed=")) continue;
    let payload: any;
    try {
      const response = await context.request.get(api, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: `${HOME}`,
          Origin: "https://www.doubao.com",
        },
        timeout: 30000,
      });
      if (!response.ok()) continue;
      payload = await response.json();
    } catch {
      continue;
    }
    // 返回结构容错：CDTV 里两种包法都见过。
    const data = payload?.video_info?.data ?? payload?.data;
    const keySeed = data?.key_seed;
    const list = data?.video_list;
    if (typeof keySeed !== "string" || !keySeed || !list || typeof list !== "object") continue;

    for (const [definition, item] of Object.entries(list as Record<string, any>)) {
      if (!item || typeof item !== "object") continue;
      // logo_type 非空 = 这一档是带标记的版本，跳过。
      if (String(item.logo_type ?? "").trim()) continue;
      for (const field of ["main_url", "backup_url_1"]) {
        const url = decodeFplayUrl(item[field], keySeed);
        if (!url || /watermark/i.test(url)) continue;
        const width = Number(item.vwidth ?? item.width ?? 0);
        const height = Number(item.vheight ?? item.height ?? 0);
        found.push({
          url,
          definition,
          label: `${width || "?"}x${height || "?"}`,
          area: width * height,
        });
        break;
      }
    }
  }
  if (!found.length) return null;
  found.sort((left, right) => right.area - left.area);
  log(`fplay 解析到无水印原片：${found[0].definition}（${found[0].label}）`);
  return { url: found[0].url, definition: found[0].definition, label: found[0].label };
}

/* ------------------------------------------------------------------ 登录 */

/** 打开浏览器让用户扫码；已登录则直接返回。传入 profileDir 即为「新增账号」。 */
export async function openLogin(profileDir?: string, accountType?: string): Promise<void> {
  const type = normalizeAccountType(accountType);
  const home = homeUrlOf(type);
  const label = platformLabel(type);
  const context = await launchContext(profileDir || PROFILE_ROOT);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 扫码授权必须让用户看得见：把浏览器窗口摆到屏幕内并置前。
    // （桌面端已不再收编这个窗口 —— 用户反馈侧栏里「来回乱跳」反而更难用。）
    await revealBrowserWindow(page);
    if (await isLoggedIn(context, type)) return;
    await assertPlatformAccessible(page, type);
    log(`请在弹出的豆包浏览器窗口里扫码登录 ${label}（${home}），完成后会自动继续`);
    // Dola 页面较重，实测等待期间偶发 renderer 崩溃（自动探针里复现过）。
    // 崩了就把登录页**换一个新页**重开继续等，而不是直接失败让用户从头再来。
    // （必须换新页：崩溃后的 page 对象已经不可用，继续用它只会连环报错。）
    let crashed = false;
    let activePage = page;
    page.on("crash", () => { crashed = true; });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await activePage.waitForTimeout(2000).catch(() => undefined);
      if (crashed) {
        crashed = false;
        log("登录页崩溃，正在重新打开登录页…");
        const broken = activePage;
        activePage = await context.newPage();
        await broken.close().catch(() => undefined);
        await activePage.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
        await revealBrowserWindow(activePage);
        activePage.on("crash", () => { crashed = true; });
        await assertPlatformAccessible(activePage, type);
        continue;
      }
      await assertPlatformAccessible(activePage, type);   // 地区受限就别让用户干等
      if (await isLoggedIn(context, type)) return;
    }
    throw new Error(`${label}登录超时，请重新发起登录`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ 主流程 */

const generateVideo: GenerateMedia<any> = async function (request: VideoRequest) {
  const tool = (this as any)?.tool;
  const signal = (this as any)?.signal;

  // 由 RPA 服务选好账号后传入；不传则沿用默认 profile。
  const profileDir = String((request as any)?.profileDir || PROFILE_ROOT);
  // 账号所属平台（豆包 / Dola）：站点、登录判据、页面控件都按它分支。
  const accountType = normalizeAccountType((request as any)?.accountType);
  const home = homeUrlOf(accountType);
  const label = platformLabel(accountType);
  await mkdir(profileDir, { recursive: true });
  const context = await launchContext(profileDir);

  try {
    if (!(await isLoggedIn(context, accountType))) {
      // 登录态失效时不能只丢一句报错：用户根本不知道窗口在哪。
      // 把窗口摆到屏幕内并等他扫码，登上了就继续本次生成。
      const page0 = context.pages()[0] ?? (await context.newPage());
      await page0.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
      await revealBrowserWindow(page0);
      log(`${label}登录态已失效：已弹出浏览器窗口并打开登录页，请在 10 分钟内扫码登录，登录后会自动继续生成…`);
      const loginDeadline = Date.now() + LOGIN_TIMEOUT_MS;
      let logged = false;
      while (Date.now() < loginDeadline) {
        await page0.waitForTimeout(3000);
        if ((logged = await isLoggedIn(context, accountType))) break;
      }
      if (!logged) throw new Error(`${label}账号未登录：等待扫码登录超时，请重新生成`);
      log(`已检测到${label}登录成功，继续本次生成…`);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await assertPlatformAccessible(page, accountType);

    // 网络证据：成片的真实地址常只在响应里出现，DOM 上的 <video> 可能是 blob。
    // 注意 baseline 只能在提交前拍一次快照；若让 remember 同时写 baseline，
    // 那么「新出现的地址」永远被判为旧地址，成片 URL 会被整个漏掉。
    const allUrls = new Set<string>();
    const remember = (url: string) => {
      if (!MEDIA_HOSTS.some((host) => url.includes(host))) return;
      allUrls.add(url);
    };
    const onRequest = (req: any) => remember(String(req.url() || ""));
    const onResponse = (res: any) => remember(String(res.url() || ""));
    page.on("request", onRequest);
    page.on("response", onResponse);

    // 顺手收下 fplay 地址：成片的**原片**编码只能从这里问出来。
    // ⚠️ 关键（2026-10-13 实测踩过）：fplay 地址**不在任何请求里**，而是嵌在
    //    **会话消息的 JSON** 里（域名还是 vas-lf-x.snssdk.com，不是 doubao.com），
    //    所以必须扫**响应体**——只按 URL 过滤 `key_seed=` 一条都抓不到（实测 0 条）。
    const fplayApis = new Set<string>();
    const onFplayResponse = (res: any) => {
      void (async () => {
        try {
          const type = String(res.headers()["content-type"] || "");
          if (!/json|text/i.test(type)) return;
          const body = await res.text();
          if (!body || !body.includes("key_seed")) return;
          // 消息体里的 URL 被 JSON 转义过，先还原再匹配。
          const text = body.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
          for (const matched of text.match(/https?:\/\/[^"'\\\s]*\/video\/fplay\/[^"'\\\s]+/g) ?? []) {
            const url = matched.replace(/[",}].*$/, "");
            // 只收带 key_seed 的那种：没有 key_seed 就解不出地址（消息体里还有一份不带查询串的变体）。
            if (url.includes("key_seed=")) fplayApis.add(url);
          }
        } catch {
          /* 读不到响应体（流式 / 已释放）就跳过 */
        }
      })();
    };
    page.on("response", onFplayResponse);

    log("新建对话…");
    await openNewConversation(page);
    log("进入视频生成模式…");
    await openVideoCreation(page);

    // ⚠️⚠️ 这里必须传 **request.model**（画布上用户真正选的那个型号），不能写死。
    //    原来写死成 "Seedance 2.0 Fast"，于是用户在画布上选 Mini / 2.0 也一律
    //    按 Fast 生成 —— 而 selectModel() 里那套「按点名型号去下拉里切」的逻辑
    //    等于白写（函数的注释还在说"画布侧可能传 Seedance 2.0 Fast"，根本没传）。
    //    2026-10-12 用户报「我选的 mini，怎么还是用 fast 生成」就是这一处。
    const wantedModel = String(request.model || "Seedance 2.0 Fast");
    await selectModel(page, wantedModel);
    // 记下**实际**落到的型号：selectModel 是尽力而为，切不到会沿用页面当前值，
    // 不记这一行就永远说不清"这次到底用了哪个型号"（本次排查就吃了这个亏）。
    log(`本次型号：请求「${wantedModel}」，页面实际「${(await currentModelLabel(page)) || "未知"}」`);

    const files = (request.images ?? [])
      .map((image: any, index: number) => toUploadFile(image, index))
      .filter(Boolean);
    if (files.length) await uploadImages(page, files);

    const targetDuration = Number(request.duration) || 5;
    await configureVideo(page, String(request.ratio || "自动"), targetDuration, accountType);

    const promptParts = [request.prompt];
    if (request.ratio && request.ratio !== "智能" && request.ratio !== "auto") promptParts.push(`画面比例 ${request.ratio}`);
    await fillPrompt(page, promptParts.filter(Boolean).join("，"));
    await page.waitForTimeout(800);

    const beforeVideos = await page.locator("video").count();
    const beforeFingerprints = await videoFingerprints(page);
    /** 提交前的地址快照：只有提交后新出现的地址才算成片候选。 */
    const baselineUrls = new Set(allUrls);

    /**
     * 成片的字节流。
     *
     * 豆包播放器的 <video> 往往是「先给封面图、点播放才去拉 mp4」，
     * 而且成片 CDN 域名会变（douyinvod / byteimg 等）。
     * 因此主力手段是**按响应内容类型抓二进制**，DOM 直链只作兜底。
     */
    let videoBytes: Uint8Array | null = null;
    let videoSource = "";
    const onMediaResponse = (res: any) => {
      void (async () => {
        try {
          const headers = res.headers();
          const contentType = String(headers["content-type"] || "");
          const url = String(res.url() || "");
          const looksVideo = /^video\//i.test(contentType)
            || /application\/octet-stream/i.test(contentType)
            || /\.mp4(\?|$)/i.test(url)
            || /\/video\/tos\//i.test(url);
          if (!looksVideo) return;
          const length = Number(headers["content-length"] || 0);
          if (length && length < 50_000) return; // 预览小片段不算
          const body = await res.body();
          if (body && body.length > 50_000 && (!videoBytes || body.length > videoBytes.length)) {
            videoBytes = new Uint8Array(body);
            videoSource = String(res.url() || "");
            log(`已抓到成片数据流：${(body.length / 1048576).toFixed(1)} MB`);
          }
        } catch { /* 流式响应读不到，交给直链兜底 */ }
      })();
    };
    page.on("response", onMediaResponse);

    log("提交生成…");
    await clickGenerate(page);

    const deadline = Date.now() + TIMEOUT_MS;
    const submitAt = Date.now();
    let tick = 0;
    let authorizationRounds = 0;
    let confirmRounds = 0;
    let lastConfirmAt = 0;
    let playTriggered = false;
    let lastTriedUrl = "";
    let resultUrl = "";
    let blocked = "";

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("任务已取消");
      await page.waitForTimeout(POLL_MS);

      if (!context.pages().length) throw new Error("豆包浏览器已被关闭");
      await dismissDownloadDialog(page);

      if (await visibleAuthorizedMaterialDialog(page)) {
        if (authorizationRounds < 3) {
          authorizationRounds += 1;
          if (await confirmAuthorizedMaterial(page)) {
            log(`安全确认已自动通过（${authorizationRounds}/3）`);
            continue;
          }
        }
        continue; // 自动确认没通过时留着让用户手动点，不误判为失败
      }

      blocked = await blockReason(page);
      // 人工安全验证是可恢复的：把窗口交给用户、等他点完继续。
      // 其它 blocked（侵权/人脸/额度等）才是终态。
      if (blocked && /人工安全验证/.test(blocked)) {
        await handleCaptcha(page);
        blocked = "";
        continue;
      }
      if (blocked) break;

      // 豆包会先回一条「视频生成参数确认…确认后我再开始生成视频」，必须先补一句确认。
      // 判据直接取页面尾部文本，不依赖助手消息容器的 class（豆包改版后会变）。
      // 但整段对话的尾部会一直包含那条旧的确认询问，所以还要排除「已经在排队生成」的状态：
      // 豆包一旦接受，会说「预计等待 N 分钟…生成好后我会主动发送给你」，
      // 此时再补发确认就是多余消息（实测会误发第 2 次）。
      // 最多补 2 次，且两次之间至少隔 60 秒。
      if (confirmRounds < 2 && Date.now() - lastConfirmAt > 60_000) {
        const tail = (await pageAndFrameText(page)).replace(/[*_`]+/g, "").replace(/\s+/g, " ");
        const recent = tail.slice(-400);
        if (RE_CONFIRM_REQUEST.test(tail.slice(-1500)) && !RE_ALREADY_GENERATING.test(recent)) {
          confirmRounds += 1;
          lastConfirmAt = Date.now();
          log(`豆包要求确认生成参数，补发确认语句（第 ${confirmRounds} 次）…`);
          await fillPrompt(page, "我确认，开始生成视频");
          await clickGenerate(page);
          continue;
        }
      }

      const videoCount = await page.locator("video").count();
      const fingerprints = await videoFingerprints(page);
      const hasNewVideo = [...fingerprints].some((item) => !beforeFingerprints.has(item));
      const tailText = await pageAndFrameText(page);
      // 「video 元素出现」不能作为唯一判据：豆包先给封面图，点了播放才注入 <video>
      const produced = videoReady(tailText) || hasNewVideo || videoCount > beforeVideos;

      tick += 1;
      if (tick % 15 === 0) {
        const bottom = await page
          .evaluate(() => {
            const visible = (el: Element) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            return Array.from(document.querySelectorAll("body *"))
              .filter(visible)
              .slice(-400)
              .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
              .filter((text) => /生成中|正在生成|排队|等待|完成|秒|分钟|进度|生成好了/.test(text))
              .slice(-2)
              .join(" | ");
          })
          .catch(() => "");
        log(`等待出片 ${Math.round((Date.now() - submitAt) / 1000)}s｜video=${videoCount}｜已抓到字节=${videoBytes ? "是" : "否"}｜页面：${bottom || "（无进度文案）"}`);
        try {
          const debugDir = resolve(process.cwd(), "assets", "doubao-debug");
          await mkdir(debugDir, { recursive: true });
          await page.screenshot({ path: resolve(debugDir, `wait-${Math.round((Date.now() - submitAt) / 1000)}s.png`) });
        } catch { /* 截图失败不影响主流程 */ }
      }

      if (!produced) continue;

      // ① 响应监听已经拿到成片字节 —— 最可靠，直接用
      if (videoBytes) {
        resultUrl = videoSource;
        break;
      }

      // ② 封面帧就位但 mp4 还没请求：点一次播放器，让真实请求发出来
      if (!playTriggered) {
        playTriggered = true;
        await page
          .evaluate(() => {
            const node = Array.from(document.querySelectorAll("video")).at(-1) as HTMLVideoElement | undefined;
            if (!node) return;
            try {
              node.load();
              void node.play();
            } catch { /* 自动播放被拦时忽略 */ }
          })
          .catch(() => undefined);
        const clicked = await nudgePlayback(page);
        log(`已触发播放（点击播放器=${clicked}），等待成片数据流…`);
        continue;
      }

      // ③ 直链兜底：DOM 属性 + 提交后新出现的网络地址
      const candidate =
        pickMediaUrl(await pageVideoSources(page)) ||
        pickMediaUrl([...allUrls].filter((url) => !baselineUrls.has(url)));
      if (candidate && candidate !== lastTriedUrl) {
        lastTriedUrl = candidate;
        try {
          const response = await context.request.get(candidate, { timeout: 120000 });
          if (response.ok()) {
            const body = await response.body();
            if (body && body.length > 50_000) {
              videoBytes = new Uint8Array(body);
              resultUrl = candidate;
              break;
            }
          }
        } catch { /* 换下一个候选 */ }
      }
    }

    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("response", onMediaResponse);
    page.off("response", onFplayResponse);

    if (blocked) throw new Error(blocked);
    if (!videoBytes) throw new Error("等待豆包出片超时，请重试");

    const outputDir = resolve(process.cwd(), "assets", "generated");
    await mkdir(outputDir, { recursive: true });
    const name = `doubao-${Date.now()}-${fileNameSafe(String(request.prompt || "").slice(0, 24) || "video")}.mp4`;
    const outputPath = resolve(outputDir, name);
    await writeFile(outputPath, videoBytes);
    // 成片来源（哪个地址抓到的）：排查"这版是哪条链路给的"时全靠这一行。
    const sourceHost = (() => {
      try {
        return new URL(resultUrl).host;
      } catch {
        return resultUrl ? "未知" : "未记录";
      }
    })();
    log(`成片已保存：${outputPath}（${(videoBytes.length / 1048576).toFixed(1)} MB）｜来源 ${sourceHost}`);

    // ── 有条件的「去水印」───────────────────────────────────────────────
    // 判据不是"认水印长什么样"，而是**拿平台原片当参照物做 A/B 差分**：
    // 同一画面的两种编码差值是零散压缩噪声（外接框铺满画面、填充率≈0），
    // 而水印只存在于其中一份里，会单独暴露成**一小块实心区域**。
    // 判定动作也是安全的：判有水印 → 换成官方原片（无损，不是抹像素）；
    // 判没有 → 原样保留、不做任何重编码（避免白白降质）。
    // 详细依据与实测数字见 doubao-watermark.ts 顶部。
    const videoId = extractVideoId(videoBytes);
    if (accountType === "doubao" && videoId) {
      if (!fplayApis.size) {
        log(`未捕获到 fplay 地址，跳过水印判定（video_id=${videoId}）`);
      } else {
        const original = await resolveOriginalViaFplay(context, [...fplayApis]).catch(() => null);
        if (!original) {
          log(`未能解析出平台原片，跳过水印判定`);
        } else {
          const tempPath = resolve(outputDir, `.original-${Date.now()}.mp4`);
          try {
            const response = await context.request.get(original.url, { timeout: 120000 });
            const body = await response.body();
            if (!response.ok() || !body || body.length <= 50_000) {
              log(`原片下载不完整（HTTP ${response.status?.() ?? "?"}），保持原样`);
            } else {
              await writeFile(tempPath, body);
              const verdict = await compareForWatermark(outputPath, tempPath);
              log(`水印判定：${verdict.reason}`);
              if (verdict.watermarked) {
                // 抓取版留一份存档：万一判错也能追回来，不销毁证据。
                const archived = outputPath.replace(/\.mp4$/, ".抓取版.mp4");
                await writeFile(archived, videoBytes);
                await writeFile(outputPath, body);
                videoBytes = new Uint8Array(body);
                log(
                  `已换用平台原片（${original.definition} ${original.label}，` +
                    `${(body.length / 1048576).toFixed(1)} MB）｜区域 ${JSON.stringify(verdict.box)}｜抓取版存档 ${archived}`,
                );
              } else {
                log("未检出差异区域，保留抓到的成片（不重编码）");
              }
            }
          } catch (error) {
            log(`原片比对失败，保持原样：${String(error).slice(0, 140)}`);
          } finally {
            await rm(tempPath, { force: true }).catch(() => undefined);
          }
        }
      }
    }

    return [
      {
        mediaType: "video",
        type: "url",
        url: `file://${outputPath.replace(/\\/g, "/")}`,
        mimeType: "video/mp4",
      } as MediaAsset,
    ];
  } finally {
    await context.close().catch(() => undefined);
  }
};

export default {
  id: "doubaoAccount",
  label: "豆包账号（免费额度）",
  version: version,
  apiUrl: HOME,
  readme: "## 豆包 / Dola 账号（免费额度）\n\n用你自己的账号，通过浏览器自动化操作网页版生成视频，消耗账号每日免费额度，不额外付费。\n\n**支持两个平台**（在同一处绑定，账号池统一调度）：\n- **豆包**（`doubao.com`，国内）：每日免费额度通常 3～5 条 10 秒视频。\n- **Dola**（`dola.com`，海外）：独立站点与独立每日额度，按账号发放。\n\n**首次使用**：新增账号并选择平台 → 扫码登录（登录时软件会弹出一个浏览器窗口，在那个窗口里扫码即可），登录态保存在本机。\n\n**工作方式**\n- 生成时会打开一个真实 Chrome 窗口操作对应平台的网页（窗口在屏幕内，可随时查看；需要扫码登录或人工验证时会自动移到最前）。\n- 额度耗尽会自动标记该账号并换下一个；两个平台各自独立计数。\n- 若页面弹出「素材已获授权」安全确认，会自动确认；连续 3 轮未通过时需要人工在浏览器里点一下。\n- 需要本机已安装 Chrome 或 Edge（Windows 10/11 自带 Edge，无需额外安装）。",
  rules: [{ field: "note", value: "首次使用请先新增账号（可选豆包或 Dola）并完成扫码登录；登录态保存在本机" }],
  models: [
    {
      id: "Seedance 2.0 Fast",
      label: "豆包 Seedance 2.0 Fast（免费）",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "Seedance 2.0 Mini",
      label: "豆包 Seedance 2.0 Mini（免费）",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "Seedance 2.0",
      label: "豆包 Seedance 2.0（免费）",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["480p", "720p", "1080p"] }],
    },
  ],
  generateVideo: generateVideo,
  openLogin: openLogin,
};
