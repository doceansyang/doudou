import type { GenerateMedia, MediaAsset, VideoRequest } from "@toonflow/providers";
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ACCOUNT_PLATFORMS,
  addAccount,
  loadAccounts,
  normalizeAccountType,
  setAccountIdentity,
  type AccountType,
} from "./doubao-accounts.ts";
import { deshadowVideo } from "./doubao-deshadow.ts";

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
/* --------------------------------------------------------- 浏览器内核选择 */

/** 与账号池同一处数据目录：`<cwd>/data/doubao/`。 */
const DOUBAO_DATA_DIR = resolve(process.cwd(), "data", "doubao");
const BROWSER_FILE = resolve(DOUBAO_DATA_DIR, "browser.json");
const ACCOUNTS_DIR = resolve(homedir(), ".toonflow-doubao-accounts");
const LEGACY_PROFILE_DIR = resolve(homedir(), ".toonflow-doubao-profile");

/** 进程内缓存（undefined = 已经算过但没找到；null = 还没算）。 */
let browserCache: string | undefined | null = null;

/** 是不是 Chromium 内核 —— 看它目录里有没有 Chromium 的资源包。 */
function isChromium(exe: string): boolean {
  try {
    const dir = dirname(exe);
    if (existsSync(join(dir, "chrome_100_percent.pak"))) return true;
    return readdirSync(dir).some((name) => existsSync(join(dir, name, "chrome_100_percent.pak")));
  } catch {
    return false;
  }
}

/** 本机装了哪些 Chromium 内核浏览器（Chrome / Edge），按推荐顺序。 */
export function listInstalledBrowsers(): Array<{ path: string; name: string }> {
  if (process.platform === "darwin") {
    return [
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Microsoft Edge" },
    ].filter((item) => existsSync(item.path));
  }
  if (process.platform !== "win32") {
    return [
      { path: "/usr/bin/google-chrome", name: "Google Chrome" },
      { path: "/usr/bin/chromium", name: "Chromium" },
      { path: "/usr/bin/microsoft-edge", name: "Microsoft Edge" },
    ].filter((item) => existsSync(item.path));
  }
  const local = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    { path: join(programFiles, "Google\\Chrome\\Application\\chrome.exe"), name: "Google Chrome" },
    { path: join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"), name: "Google Chrome" },
    { path: local && join(local, "Google\\Chrome\\Application\\chrome.exe"), name: "Google Chrome（用户目录）" },
    { path: join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"), name: "Microsoft Edge" },
    { path: join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"), name: "Microsoft Edge" },
  ].filter((item): item is { path: string; name: string } => Boolean(item.path) && existsSync(item.path));
}

/** 老装机（已经存在浏览器 profile）。 */
function hasExistingProfiles(): boolean {
  if (existsSync(LEGACY_PROFILE_DIR)) return true;
  try {
    return readdirSync(ACCOUNTS_DIR).length > 0;
  } catch {
    return false;
  }
}

/** 读 `browser.json` 里记下的选择。 */
export function savedBrowser(): string {
  try {
    const data = JSON.parse(readFileSync(BROWSER_FILE, "utf-8")) as { executable?: string };
    return typeof data?.executable === "string" ? data.executable : "";
  } catch {
    return "";
  }
}

/** 记住选定的浏览器（粘性；下次启动沿用，避免换内核导致已有登录态失效）。 */
export function saveBrowser(executable: string): void {
  mkdirSync(DOUBAO_DATA_DIR, { recursive: true });
  writeFileSync(
    BROWSER_FILE,
    JSON.stringify({ executable, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  browserCache = null; // 让下一次解析重新取值
}

/** 当前生效的浏览器 + 它从哪来（界面上要如实显示）。 */
export function browserState(): { current: string; source: string; candidates: Array<{ path: string; name: string }> } {
  const override = process.env.DOUBAO_BROWSER ?? "";
  const saved = savedBrowser();
  const candidates = listInstalledBrowsers();
  if (override && existsSync(override)) return { current: override, source: "环境变量 DOUBAO_BROWSER", candidates };
  if (saved && existsSync(saved)) return { current: saved, source: "已保存的选择", candidates };
  const current = chromeExecutable() ?? "";
  return { current, source: hasExistingProfiles() ? "沿用历史顺序（老装机）" : "自动挑的", candidates };
}

/**
 * 选 Chromium 内核浏览器。
 *
 * ⚠️⚠️ **必须与 profile 一致，而且一旦定下就要粘住**：Chromium 从 127 起 cookie 用
 * 「绑定到程序」的密钥加密（App-Bound），**Chrome 建的 profile 换成 Edge 打开就读不出
 * cookie** ⇒ 登录态全丢、所有号得重扫一遍。所以：
 *   · 优先 `DOUBAO_BROWSER` 环境变量（强制指定 / 排障）
 *   · 其次 `data/doubao/browser.json`（粘性选择，账号管理页可改）
 *   · 老装机（已有 profile）没记录时沿用历史的 Chrome→Edge 顺序，**不悄悄换内核**
 *   · 全新装机才自由挑：本机装着哪个用哪个（Chrome 优先 —— 风控策略最宽松）
 *
 * ⚠️ 「用户的默认浏览器」这里**故意不自动采用**：Windows 的默认浏览器只能从注册表读
 * （`reg.exe` 在某些安全策略下会被拦），而我们这边没法保证读得到；更要紧的是，
 * 用户日常默认浏览器 ≠ 我们该用的内核（豆包风控对 Chrome 更宽松），而且一旦换内核
 * 已有登录态就废了。所以这里给**显式选择**，默认保守。
 */
function chromeExecutable(): string | undefined {
  if (browserCache !== null) return browserCache || undefined;
  const override = process.env.DOUBAO_BROWSER ?? "";
  if (override && existsSync(override) && isChromium(override)) {
    browserCache = override;
  } else {
    if (override) log(`忽略 DOUBAO_BROWSER（不存在或不是 Chromium 内核）：${override}`);
    const saved = savedBrowser();
    if (saved && existsSync(saved)) browserCache = saved;
    else {
      if (saved) log(`上次用的浏览器不在了：${saved}，重新挑一个`);
      browserCache = listInstalledBrowsers()[0]?.path;
    }
  }
  if (browserCache) log(`浏览器内核：${browserCache}`);
  else log("没找到可用的 Chromium 内核浏览器（Chrome / Edge），登录与生成都会失败");
  return browserCache || undefined;
}

/**
 * 当前生效的内核可执行文件。
 *
 * 服务端在「新建账号」成功后用它把内核**记到账号上** —— 之后这个号就一直用它，
 * 哪怕全局选择后来变了（否则跨内核打开就丢登录态，用户又要重新扫码）。
 */
export function currentBrowser(): string {
  return chromeExecutable() || "";
}

/* ------------------------------------------- 从「用户指定的浏览器」同步登录态 */

const wait = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 本机装着的 Chromium 内核浏览器 + 它的用户数据目录。 */
export type BrowserCandidate = {
  id: string;
  name: string;
  executable: string;
  /** 传给 `--user-data-dir` 的目录（登录数据在里面）。 */
  userDataDir: string;
  /** profile 子目录名（通常 Default）。 */
  profileDirectory: string;
  /**
   * 这个浏览器的 **profile 是否被占用**（占用 = 同步不了，要请用户先退出它）。
   *
   * ⚠️ 判据是「cookie 库能不能打开」而**不是**「进程名在不在跑」——
   * 后者会把任何叫 chrome.exe 的东西算进来（Playwright 自带的 Chromium、
   * 别家的 Chromium 套壳都叫这个名），实测误报过：Chrome 明明没开却被标成"正在运行"。
   */
  running: boolean;
  /**
   * 这个浏览器当前有几个进程（**只用来解释给用户听**，不用作判据）。
   *
   * 用户最常见的困惑是「我 Edge 明明关了啊」—— 其实是窗口关了、进程还常驻
   * （Edge 默认开着「启动增强 / 关闭后继续运行后台扩展」，实测关掉窗口后仍留 11 个）。
   * 把这个数字摆出来，"关不掉"就变成看得见的事了。
   */
  processCount: number;
  /**
   * 这个浏览器的 cookie 库里有没有 doubao 的记录。
   *
   * ⚠️ 只查 `host_key` 这种**明文**列（grep 原始文件字节），**绝不解密任何 cookie 值** ——
   * 目的是让界面能提前标出"哪个浏览器里登录过豆包"，而不是偷看内容。
   * `null` = 读不到（profile 被占用）—— 别把"读不到"谎报成"没有"。
   */
  hasDoubao: boolean | null;
};

/** 已知的 Chromium 内核浏览器（Firefox 扩展机制不同，暂不支持）。 */
function browserRecipe(): Array<{ id: string; name: string; exe: string[]; userData: string[]; proc: string }> {
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pfx = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  if (process.platform !== "win32") {
    return [
      { id: "chrome", name: "Google Chrome", exe: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], userData: [join(homedir(), "Library/Application Support/Google/Chrome")], proc: "Google Chrome" },
      { id: "edge", name: "Microsoft Edge", exe: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"], userData: [join(homedir(), "Library/Application Support/Microsoft Edge")], proc: "Microsoft Edge" },
    ];
  }
  return [
    {
      id: "chrome",
      name: "Google Chrome",
      exe: [join(pf, "Google\\Chrome\\Application\\chrome.exe"), join(pfx, "Google\\Chrome\\Application\\chrome.exe"), local && join(local, "Google\\Chrome\\Application\\chrome.exe")],
      userData: [local && join(local, "Google\\Chrome\\User Data")],
      proc: "chrome.exe",
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      exe: [join(pfx, "Microsoft\\Edge\\Application\\msedge.exe"), join(pf, "Microsoft\\Edge\\Application\\msedge.exe")],
      userData: [local && join(local, "Microsoft\\Edge\\User Data")],
      proc: "msedge.exe",
    },
    {
      id: "360",
      name: "360 安全浏览器",
      exe: [join(pfx, "360Chrome\\Chrome\\Application\\360chrome.exe"), join(pf, "360Chrome\\Chrome\\Application\\360chrome.exe"), local && join(local, "360Chrome\\Chrome\\Application\\360chrome.exe")],
      userData: [local && join(local, "360Chrome\\Chrome\\User Data")],
      proc: "360chrome.exe",
    },
    {
      id: "quark",
      name: "夸克浏览器",
      exe: [local && join(local, "Quark\\Application\\QuarkPC.exe"), join(pf, "Quark\\Application\\QuarkPC.exe"), local && join(local, "Programs\\Quark\\QuarkPC.exe")],
      userData: [local && join(local, "Quark\\User Data")],
      proc: "QuarkPC.exe",
    },
    {
      id: "qq",
      name: "QQ 浏览器",
      exe: [join(pf, "Tencent\\QQBrowser\\QQBrowser.exe"), join(pfx, "Tencent\\QQBrowser\\QQBrowser.exe"), local && join(local, "Tencent\\QQBrowser\\QQBrowser.exe")],
      userData: [local && join(local, "Tencent\\QQBrowser\\User Data")],
      proc: "QQBrowser.exe",
    },
    {
      id: "brave",
      name: "Brave",
      exe: [join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), local && join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
      userData: [local && join(local, "BraveSoftware\\Brave-Browser\\User Data")],
      proc: "brave.exe",
    },
  ];
}

/**
 * profile 是否被占用 —— 看 cookie 库能不能打开。
 *
 * 浏览器跑着的时候这个文件是打不开的（实测 Edge 在跑时读它直接抛错），
 * 所以它比"进程名"准得多，也正好等于"现在能不能同步"。
 */
function isProfileLocked(profileDir: string): boolean {
  for (const rel of ["Network\\Cookies", "Cookies"]) {
    const file = join(profileDir, rel);
    if (!existsSync(file)) continue;
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * cookie 库里有没有 doubao 记录 —— 只搜**明文**字节，不碰加密的值。
 *
 * 为什么不解密：cookie 库从 Chromium 127 起是 App-Bound 加密，离线解不开；
 * 但 `host_key`（域名）这一列是明文存的，够用来回答"这个浏览器登录过豆包吗"。
 */
function cookiesMentionDoubao(profileDir: string): boolean | null {
  for (const rel of ["Network\\Cookies", "Cookies"]) {
    const file = join(profileDir, rel);
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file).includes("doubao")) return true;
    } catch {
      // 被占用 ⇒ 未知。绝不能报成"没有豆包"。
      return null;
    }
  }
  return false;
}

/** 数这个镜像名有几个进程（仅供界面解释，**不参与"能否同步"的判断**）。 */
function countProcess(proc: string): number {
  try {
    if (process.platform !== "win32") {
      const out = spawnSync("pgrep", ["-f", proc], { encoding: "utf8", windowsHide: true });
      return String(out.stdout ?? "").trim().split("\n").filter(Boolean).length;
    }
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${proc}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    const needle = `"${proc.toLowerCase()}"`;
    return String(out.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(needle)).length;
  } catch {
    return 0;
  }
}

/** 取某个浏览器当前的 profile 目录（多用户配置时优先 Default）。 */
function profileDirOf(item: { userData: string[] }): string {
  const userDataDir = item.userData.find((path): path is string => Boolean(path) && existsSync(path));
  if (!userDataDir) return "";
  let profileDirectory = "Default";
  if (!existsSync(join(userDataDir, profileDirectory))) {
    const sibling = readdirSync(userDataDir).find((name) => /^Profile \d+$/.test(name));
    if (sibling) profileDirectory = sibling;
  }
  return join(userDataDir, profileDirectory);
}

/**
 * 彻底退出某个浏览器 —— 只在用户点「退出并同步」时调用。
 *
 * 为什么必须真退干净（而不是"边跑边读"）：我们的读取方式是拿**它自己的
 * user-data-dir** 无头启动一次、让浏览器自己把 Cookie 写进网络日志。而 Chromium 的
 * user-data-dir 是**单实例**的：已有进程在用时新进程拿不到这个 profile；
 * 同时 Cookies 库是被**独占**打开的（实测连"只读 + 允许共享"都被拒），
 * 加上 ABE 加密与复制 profile 的路径校验 ⇒ 运行中没有任何合法通路能读到它。
 */
export async function closeBrowser(id: string): Promise<{ ok: boolean; killed: number; freed: boolean; error?: string }> {
  const item = browserRecipe().find((entry) => entry.id === id);
  if (!item) return { ok: false, killed: 0, freed: false, error: "未知的浏览器" };
  const profileDir = profileDirOf(item);
  if (!profileDir) return { ok: false, killed: 0, freed: false, error: "找不到该浏览器的用户数据目录" };
  const killed = countProcess(item.proc);
  try {
    if (process.platform === "win32") {
      // /T 连子进程一起收；/F 不弹确认。⚠️ 目标只限这一种镜像名，
      // 不会碰本软件自己的 WebView2（那个叫 msedgewebview2.exe）。
      spawnSync("taskkill", ["/IM", item.proc, "/T", "/F"], { windowsHide: true });
    } else {
      spawnSync("pkill", ["-f", item.proc], { windowsHide: true });
    }
  } catch {
    // 杀不动也没关系 —— 下面用"profile 到底放开了没"作为唯一判据。
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!isProfileLocked(profileDir)) {
      log(`${item.name} 已退出（原有 ${killed} 个进程），登录数据已释放`);
      return { ok: true, killed, freed: true };
    }
    await wait(600);
  }
  return {
    ok: true,
    killed,
    freed: false,
    error: `已经退出了 ${item.name} 的进程，但它的登录数据仍被占用（可能有别的程序正在用这个用户目录）`,
  };
}

/** 扫描本机装着的 Chromium 浏览器（给引导页的"选浏览器"用）。 */
export function listBrowserCandidates(): BrowserCandidate[] {
  const out: BrowserCandidate[] = [];
  for (const item of browserRecipe()) {
    const executable = item.exe.find((path): path is string => Boolean(path) && existsSync(path));
    if (!executable) continue;
    const userDataDir = item.userData.find((path): path is string => Boolean(path) && existsSync(path));
    if (!userDataDir) continue;
    // 多用户配置：优先 Default，否则取第一个 Profile *
    let profileDirectory = "Default";
    if (!existsSync(join(userDataDir, profileDirectory))) {
      const sibling = readdirSync(userDataDir).find((name) => /^Profile \d+$/.test(name));
      if (sibling) profileDirectory = sibling;
    }
    const profileDir = join(userDataDir, profileDirectory);
    const running = isProfileLocked(profileDir);
    out.push({
      id: item.id,
      name: item.name,
      executable,
      userDataDir,
      profileDirectory,
      running,
      processCount: countProcess(item.proc),
      hasDoubao: running ? null : cookiesMentionDoubao(profileDir),
    });
  }
  return out;
}

/**
 * 从 netlog 文本里取出豆包那条 `Cookie` 请求头，拆成 cookie 数组。
 *
 * 为什么用 netlog：Chromium 137+ **明确禁止**对默认 profile 开远程调试
 * （`DevTools remote debugging requires a non-default data directory`），
 * 而 `--log-net-log` 是普通诊断开关、不受该限制；配合
 * `--net-log-capture-mode=IncludeSensitive` 能把请求头（含 Cookie）原样写进日志。
 * 这是「不动用户任何东西就把已登录账号读出来」在 Chrome/Edge 上唯一可行的合法路径。
 */
function parseCookiesFromNetLog(text: string): ImportedCookie[] {
  const matches = [...text.matchAll(/Cookie: ([^"]*?sessionid=[^"]*)/g)];
  if (!matches.length) return [];
  // 同一份 cookie 会在多个请求里出现；取最长的那条（最全）。
  const raw = matches.map((match) => match[1]).sort((a, b) => b.length - a.length)[0];
  const cookies: ImportedCookie[] = [];
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!/^[A-Za-z0-9_.\-]+$/.test(name) || !value) continue;
    cookies.push({ name, value, domain: ".doubao.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction" });
  }
  return cookies;
}

/**
 * 从「用户指定的浏览器」同步已登录的豆包账号。
 *
 * 做法：用它的**真实用户数据目录**无头启动一次，带上 netlog 开关并打开豆包首页；
 * 浏览器自己此刻发出的请求就带着 cookie（浏览器内部解密，绕开 App-Bound），
 * 我们从日志里把 doubao 的 Cookie 头取出来 —— 顺带把 `multi_sids` 里的
 * **全部账号**一起拿到，走与扩展/登录窗完全相同的落库路径。
 *
 * 约束与代价：
 *   · 浏览器**必须在退出状态**（运行中会占用登录数据，我们启动的新实例会把手交回旧进程、
 *     什么也读不到）；
 *   · 无头运行，用户看不到窗口；会读写该 profile 的常规文件（和用户自己开一次浏览器同理）；
 *   · netlog 只用于解析豆包 cookie，**解析完立刻删除**，不上传任何地方。
 */
export async function captureBrowserSession(
  candidate: BrowserCandidate,
): Promise<{ cookies: ImportedCookie[]; browserAccounts: BrowserAccount[]; sessionId: string }> {
  if (candidate.running) {
    throw new Error(`${candidate.name} 正在运行，它占用着登录数据。请先完全退出它，再点一次同步。`);
  }
  const netlog = join(tmpdir(), `jinyutv-netlog-${process.pid}-${Date.now()}.json`);
  await rm(netlog, { force: true }).catch(() => undefined);

  log(`从 ${candidate.name} 读取登录态（无头启动一次，只读 cookie，读完即删日志）…`);
  const child = spawn(
    candidate.executable,
    [
      `--user-data-dir=${candidate.userDataDir}`,
      `--profile-directory=${candidate.profileDirectory}`,
      `--log-net-log=${netlog}`,
      "--net-log-capture-mode=IncludeSensitive",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      homeUrlOf("doubao"),
    ],
    { stdio: "ignore", windowsHide: true },
  );

  try {
    // 轮询日志：一出现带 sessionid 的 Cookie 头就收工（通常 3～8 秒）。
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await wait(1200);
      try {
        if (/Cookie: [^"]*sessionid=/.test(readFileSync(netlog, "utf-8"))) break;
      } catch {
        // 日志还没落盘，继续等
      }
    }
  } finally {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    } catch {
      // 进程可能已自行退出
    }
  }

  let text = "";
  try {
    text = readFileSync(netlog, "utf-8");
  } catch {
    throw new Error(`没能从 ${candidate.name} 读到网络日志：请确认它已经**完全退出**（运行中的浏览器会占用登录数据，我们启动的实例会把手交回它、什么也读不到）。`);
  } finally {
    // ⚠️ 立刻删除：日志里有 cookie，绝不留在磁盘上。
    await rm(netlog, { force: true }).catch(() => undefined);
  }

  const cookies = parseCookiesFromNetLog(text);
  const sessionId = String(cookies.find((item) => item.name === "sessionid")?.value ?? "").trim();
  if (!sessionId) {
    throw new Error(`${candidate.name} 里没有登录豆包（没读到登录态）。请在该浏览器里登录一次，或改用「用登录窗口扫码」。`);
  }
  const browserAccounts = parseBrowserAccounts(String(cookies.find((item) => item.name === "multi_sids")?.value ?? ""));
  if (!browserAccounts.length) browserAccounts.push({ sessionId });
  log(`从 ${candidate.name} 读到 ${cookies.length} 条 cookie，其中登记了 ${browserAccounts.length} 个豆包账号`);
  return { cookies, browserAccounts, sessionId };
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
async function launchContext(profileDir: string = PROFILE_ROOT, headless = false, executableOverride?: string) {
  const { chromium } = await import("playwright");
  // 内核优先级：**账号自己记着的**（导入它时用的那个）→ 全局粘性选择。
  // ⚠️ 必须按账号来：cookie 的加密密钥绑定具体浏览器，Chrome 建的 profile 换 Edge 打开
  //    就读不出登录态。所以「从 Edge 同步来的号」必须一直用 Edge 打开，否则又要重新登录。
  const executable = executableOverride && existsSync(executableOverride) ? executableOverride : chromeExecutable();
  await mkdir(profileDir, { recursive: true });
  const options = {
    ...(executable ? { executablePath: executable } : {}),
    headless,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    // ★ 去掉 Playwright 默认塞进来的 `--no-sandbox`（2026-10-15 实测）。
    //
    //   Playwright 的 coreBundle 会无条件 `chromeArguments.push("--no-sandbox")`，浏览器
    //   顶部因此挂一条黄色警告条「You're using an unsupported command-line flag:
    //   --no-sandbox. This poses stability and security risks.」—— 既碍眼，更是**极明显
    //   的自动化特征**。用户截图里就有这条，而豆包正是据此弹「人工安全验证」，
    //   验证前后还会把页面掐掉（用户描述的现象就是「一直不工作然后就关了」）。
    //   去掉后浏览器用自身默认的沙箱策略，外观与真实用户一致。
    ignoreDefaultArgs: ["--no-sandbox"],
    // 无头时不带窗口参数：位置/尺寸没意义，窗口标记也只会误导后续的窗口识别。
    args: !headless && process.platform === "win32"
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
      // ★★ 不要把范围限死在 `button / [role=button]` 上（2026-10-15 修）。
      //    底栏那行「模型 Seedance 2.0 Mini」并不挂在按钮上，是普通 div/span ——
      //    只扫按钮会让这个判定**永远为 false**：明明已经停在视频模式（用户截图里
      //    底栏写着「+ ｜ 视频生成 × ｜ 模型 Seedance 2.0 Mini ｜ 自动 · 10s ｜ 🎤」），
      //    代码却以为没进去，于是反复点「视频生成」把模式切来切去，最后抛
      //    「没有找到豆包「视频生成」入口」——用户看到的就是「停在那不动 / 几秒后关掉」。
      //    这里改成扫底栏区域的**所有元素**，并只取元素**自身的文本节点**，
      //    避免父子容器重复拼接。
      const parts: string[] = [];
      const nodes = document.querySelectorAll("button, [role='button'], [role='tab'], span, div, p");
      for (const el of Array.from(nodes)) {
        if (!visible(el)) continue;
        if (el.getBoundingClientRect().top <= minY) continue;
        const own = Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent || "")
          .join("");
        const value = own.replace(/\s+/g, " ").trim();
        if (value) parts.push(value);
        if (parts.length > 400) break;
      }
      return parts.join(" | ");
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
  // ★★ 先等底栏把模式芯片画出来（2026-10-15 实测定位）。
  //
  //    豆包对话页的底栏是**异步渲染**的：进页面 2~3 秒就能看到「新对话」，
  //    但「视频生成」芯片要 10 秒左右才出现。以前这里不等，直接连点 4 次
  //    （每次只隔 1.5 秒），5 秒后就抛「没有找到豆包「视频生成」入口」——
  //    看起来像账号或内核的问题，其实是页面还没画完。
  //    它和「选错账号 ⇒ 弹错浏览器」那个 bug 叠在一起，正好就是用户看到的
  //    「弹一个浏览器、几秒后自己关掉、生成失败」。
  try {
    await page
      .getByText(new RegExp(VIDEO_MODES.join("|")))
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
  } catch {
    // 等不到就走下面的原逻辑：它有自己的重试和明确报错，别在这里把诊断信息吞掉。
  }
  // ★★ 重试要**给足时间**（2026-10-15 实测）：豆包对话页的底栏模式芯片是异步渲染的，
  //    首页要 ~10 秒、**新建对话后要更久**（实测 12 秒仍没渲染出来）。原来只重试 4 轮
  //    ×1.5 秒，5 秒就放弃并抛「没有找到入口」；把它误当成账号或内核问题排查了很久。
  //    12 轮 ×2.5 秒 ≈ 30 秒，足够覆盖渲染延迟。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await clickByTextInComposer(page, VIDEO_MODES)) {
      await page.waitForTimeout(4000);
      if (await inVideoMode(page)) return;
    }
    await page.waitForTimeout(2500);
  }
  // ★ 兜底诊断（2026-10-15）：把页面尾部文本与底栏候选倒进日志，
  //   下次一眼就能分辨是「页面还没渲染」还是「芯片文案变了 / 位置变了」，
  //   不用再靠截图和猜。
  try {
    const snapshot = await page.evaluate(() => {
      const full = document.body.innerText || "";
      const bottom = [...document.querySelectorAll("button,[role='button'],span,div")]
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.height > 0 && r.top > window.innerHeight * 0.62; // 底栏区域
        })
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t && t.length <= 18);
      return {
        tail: full.slice(-500).replace(/\n+/g, " ▸ "),
        bottomTexts: [...new Set(bottom)].slice(0, 30),
        h: window.innerHeight,
      };
    });
    log(`[诊断] URL=${page.url()}  视口高=${snapshot.h}`);
    log(`[诊断] 底栏候选=${JSON.stringify(snapshot.bottomTexts)}`);
    log(`[诊断] 页面尾部=${snapshot.tail}`);
  } catch {
    // 页面已经不可用时不打扰主流程
  }
  // ★ 失败瞬间存一张截图：页面到底长什么样一眼就看出来，比反复翻文本快得多。
  try {
    const shot = resolve(process.cwd(), "assets", `rpa-fail-${Date.now()}.png`);
    await page.screenshot({ path: shot });
    log(`[诊断] 失败截图：${shot}`);
  } catch {
    // 截图失败不影响主流程
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
/** 登录窗捞到的登录态：**全部**账号 + 全量 cookie，交上层落成账号池记录。 */
export type LoginCapture = {
  sessionId: string;
  fingerprint: string;
  userId: string;
  nickname: string;
  cookies: ImportedCookie[];
  /** 这个窗口里登录的**全部**豆包账号（豆包支持一个浏览器登多个号；至少含当前这个）。 */
  browserAccounts: BrowserAccount[];
};

/**
 * 把当前 context 的登录态整个捞出来 —— 关键是 **`multi_sids`**：
 * 它列出这个浏览器里登录的全部账号（`<uid>:<sessionid>`），
 * 所以「用户在里面登了几个号」就能一次全收，跟「从本机浏览器拉取」是同一个机制。
 */
async function captureSession(context: any, platform: { url: string }): Promise<LoginCapture> {
  const raw = await context.cookies(platform.url);
  const cookies: ImportedCookie[] = (raw as any[]).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: Number(cookie.expires) > 0 ? Number(cookie.expires) : null,
  }));
  const read = (name: string) => String(cookies.find((item) => item.name === name)?.value ?? "").trim();
  const sessionId = read("sessionid");
  const browserAccounts = parseBrowserAccounts(read("multi_sids"));
  if (!browserAccounts.length && sessionId) browserAccounts.push({ sessionId });
  const identity = await fetchDoubaoIdentity(context);
  return {
    sessionId,
    fingerprint: sessionId ? sessionFingerprint(sessionId) : "",
    userId: identity?.userId ?? "",
    nickname: identity?.name ?? "",
    cookies,
    browserAccounts,
  };
}

/** 读当前窗口的 `multi_sids`（用来判断用户是不是又登录了新账号）。 */
async function readMultiSids(context: any, url: string): Promise<string> {
  try {
    const cookies = await context.cookies(url);
    return String((cookies as any[]).find((cookie) => cookie.name === "multi_sids")?.value ?? "");
  } catch {
    return "";
  }
}

export async function openLogin(
  profileDir?: string,
  accountType?: string,
  control?: {
    signal?: AbortSignal;
    shouldFinish?: () => boolean;
    /**
     * 无头运行。
     * ⚠️ 面向用户时必须是有头（扫码要看得见），这个开关只给自动化测试 / 无显示环境用。
     */
    headless?: boolean;
    /**
     * 用哪个浏览器内核开这个登录窗。
     *
     * 重登一个**已有账号**时要传它自己记着的内核 —— cookie 加密绑定浏览器，
     * 用别的内核登录会把原来的登录态写废（两边都读不出来）。
     */
    browser?: string;
  },
): Promise<LoginCapture> {
  const type = normalizeAccountType(accountType);
  const platform = ACCOUNT_PLATFORMS[type];
  const home = platform.url;
  const label = platformLabel(type);
  const context = await launchContext(profileDir || PROFILE_ROOT, Boolean(control?.headless), control?.browser);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 扫码授权必须让用户看得见：把浏览器窗口摆到屏幕内并置前。
    // （桌面端已不再收编这个窗口 —— 用户反馈侧栏里「来回乱跳」反而更难用。）
    await revealBrowserWindow(page);
    if (await isLoggedIn(context, type)) return await captureSession(context, platform);
    await assertPlatformAccessible(page, type);
    log(
      `请在弹出的豆包窗口里扫码登录 ${label}（${home}）。` +
        `登录完成后点软件里的「完成」继续；想一次加多个账号，就用窗口里的「更多账号 → 添加账号」。`,
    );
    // Dola 页面较重，实测等待期间偶发 renderer 崩溃（自动探针里复现过）。
    // 崩了就把登录页**换一个新页**重开继续等，而不是直接失败让用户从头再来。
    // （必须换新页：崩溃后的 page 对象已经不可用，继续用它只会连环报错。）
    let crashed = false;
    let activePage = page;
    page.on("crash", () => { crashed = true; });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    // 登录成功后**不能立刻收工**：豆包支持一个浏览器登多个账号，用户很可能正接着加号。
    // 所以登录成功后先看一段「静默时间」—— 只要 multi_sids / cookie 还在变就重新计时，
    // 静默满 AUTO_FINISH_MS 才自动收工；用户点「完成」则立刻收工。
    const AUTO_FINISH_MS = 8000;
    let settledAt = 0;
    let lastSignal = "";
    while (Date.now() < deadline) {
      // 用户点了「取消」—— 立刻收工（否则这个函数会一直占着"忙碌"状态到超时）。
      if (control?.signal?.aborted) throw new Error("已取消登录");
      // 用户把登录窗口关掉了 —— 同样立刻收工，别让他白等 10 分钟。
      if (!context.pages().length) throw new Error(`${label}登录窗口已关闭，已取消登录`);
      await activePage.waitForTimeout(2000).catch(() => undefined);
      if (control?.signal?.aborted) throw new Error("已取消登录");
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
      if (!(await isLoggedIn(context, type))) continue;

      const signal = `${await readMultiSids(context, home)}|${(await context.cookies(home).catch(() => []) as any[]).length}`;
      const now = Date.now();
      if (!settledAt || signal !== lastSignal) {
        if (settledAt) log("又检测到新的豆包账号，继续等待…");
        settledAt = now;
        lastSignal = signal;
        continue;
      }
      if (control?.shouldFinish?.() || now - settledAt >= AUTO_FINISH_MS) {
        return await captureSession(context, platform);
      }
    }
    // 超时了，但确实已经登录成功 —— 照样把登录态交出去，别让用户白扫一次。
    if (await isLoggedIn(context, type)) return await captureSession(context, platform);
    throw new Error(`${label}登录超时，请重新发起登录`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/* ------------------------------------------------- 从本机浏览器导入账号 */

/**
 * 浏览器扩展推来的 cookie 条目（见 tools/doubao-cookie-bridge/），
 * 字段名沿用 `chrome.cookies.Cookie`。
 */
export type ImportedCookie = {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  expirationDate?: unknown;
};

/**
 * 把扩展给的 cookie 映射成 Playwright 的格式。
 *
 * 三个必须处理的坑：
 *  · Chrome 的 `sameSite` 是 `no_restriction | lax | strict | unspecified`，
 *    Playwright 要 `None | Lax | Strict` —— 不映射会整批 addCookies 失败。
 *  · `SameSite=None` 必须配 `Secure`，否则浏览器直接拒收；这种组合降级成 Lax，
 *    宁可丢一个属性也别让这条 cookie 整条进不去。
 *  · `__Host-` 前缀按规范要求 host-only + `path=/` + `Secure`，不能显式带 domain，
 *    这类要改写成 `url` 形式。
 */
/**
 * 导入 cookie 的**默认有效期**：180 天。
 *
 * 为什么必须有：`Cookie:` 请求头里不带 Expires，从 netlog / `multi_sids` 抠出来的 cookie
 * 天然没有过期时间。而 Playwright 的 `addCookies` 若不给 `expires`，写进去的是**会话 cookie**
 * —— context 一关就没了。于是「同步成功」只在这一刻成立：用户点生成时会重开 profile，
 * 里面已经没有登录态，又弹登录窗要他重新扫码，一键同步等于白做。豆包 sessionid 服务端
 * 约一年有效，这里给 180 天留足余量、又不至于把死 cookie 留太久。
 */
const COOKIE_TTL_SECONDS = 180 * 24 * 60 * 60;

function toPlaywrightCookie(raw: ImportedCookie): Record<string, unknown> | null {
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const domain = String(raw.domain ?? "").trim();
  const path = String(raw.path ?? "/").trim() || "/";
  const secure = Boolean(raw.secure);
  const cookie: Record<string, unknown> = {
    name,
    value: String(raw.value ?? ""),
    path,
    secure,
    httpOnly: Boolean(raw.httpOnly),
  };
  if (domain && !name.startsWith("__Host-")) cookie.domain = domain;
  else cookie.url = `https://${domain.replace(/^\./, "") || "www.doubao.com"}${path}`;

  const sameSite = ({
    // 扩展（chrome.cookies）给的是 no_restriction / lax / strict；
    // 也可能是别人从 Playwright 读出来的 None / Lax / Strict —— 两种写法都要认。
    no_restriction: "None",
    none: "None",
    lax: "Lax",
    strict: "Strict",
  } as Record<string, string>)[String(raw.sameSite ?? "").toLowerCase()];
  if (sameSite) cookie.sameSite = sameSite === "None" && !secure ? "Lax" : sameSite;

  // ⚠️⚠️ 没给过期时间时**必须补一个默认值**，否则写进去的是会话 cookie（见 COOKIE_TTL_SECONDS）。
  //   2026-10-13 对照实验实测：不带 expires → 重开 profile 里什么都没有；带上 → 登录态还在。
  const expires = Number(raw.expirationDate);
  cookie.expires = Number.isFinite(expires) && expires > 0
    ? Math.floor(expires)
    : Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  return cookie;
}

/**
 * 用「本机浏览器里已登录的豆包账号」直接建账号（不用扫码）。
 *
 * 为什么必须靠扩展送 cookie：cookie 库从 Chromium 127 起用 App-Bound 加密，
 * 离线解不开、复制 profile 会被路径校验清空（见项目记忆），
 * 而扩展读的是浏览器自己的 cookie store（含 HttpOnly 的 `sessionid`），不受这层限制。
 *
 * ⚠️ 多账号（2026-10-13 实测定案）：豆包网页端**支持同一个浏览器登录多个账号并切换**
 * （头像菜单「更多账号 / 添加账号」）。全部账号的会话 id 都在 `multi_sids` cookie 里，
 * 格式 `<uid>:<sessionid>`；而**光一个 `sessionid` 就足以认证**（实测：只写一条
 * sessionid 去问 /passport/account/info/ 即返回 user_id）。所以「一个浏览器只能出一个
 * 账号」的旧判断是错的 —— 解析清单逐个建号即可，不需要多个浏览器各装一次扩展。
 */

/** 浏览器里登录的一个豆包账号（来自 `multi_sids` cookie）。 */
export type BrowserAccount = { uid?: string; sessionId: string };

/**
 * 从 `multi_sids` / `x-tt-multi-sids` 的值里解析出**全部**已登录账号。
 *
 * 实测值形如 `1234567890123456%3Aabcdef…`（URL 编码把 `:` 写成 `%3A`）。
 * 多账号时是多个这样的片段拼接，分隔符官方没有承诺 —— 所以这里全文捞出所有
 * `uid:sessionid` 对，**不依赖分隔符**，豆包改版也不会失配。
 */
export function parseBrowserAccounts(raw: unknown): BrowserAccount[] {
  let text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    text = decodeURIComponent(text);
  } catch {
    // 解码失败就按原样匹配（值里可能本来就是裸冒号）
  }
  const out: BrowserAccount[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(\d{6,20})\s*[:：]\s*([A-Za-z0-9_-]{16,128})/g)) {
    const sessionId = match[2];
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({ uid: match[1], sessionId });
  }
  return out;
}

/**
 * 登录态指纹：同一个浏览器反复推的是同一份登录态，靠它认出来（去重用）。
 */
function loginFingerprint(cookies: ImportedCookie[]): string {
  const read = (name: string) => String(cookies.find((item) => String(item.name) === name)?.value ?? "").trim();
  if (!read("sessionid")) return "";
  return createHash("sha256").update(`${read("sessionid")}|${read("sid_tt")}`).digest("hex").slice(0, 32);
}

/**
 * 只有 sessionid 时的指纹。
 *
 * 豆包侧 `sid_tt` 恒等于 `sessionid`，所以这里按 `sid|sid` 算 —— 跟
 * `loginFingerprint()` 的口径完全一致。老账号记录里存的就是这个值，
 * 口径不改才不会在升级后把同一个账号又当成新账号建一遍。
 */
function sessionFingerprint(sessionId: string): string {
  return createHash("sha256").update(`${sessionId}|${sessionId}`).digest("hex").slice(0, 32);
}

/** 单个账号的同步结果。 */
export type ImportedAccountResult = {
  id: string;
  name: string;
  uid: string;
  loggedIn: boolean;
  created: boolean;
  accepted: number;
  /** true = 这份登录态之前就同步过且有效，本次没做任何事（省掉一次浏览器启动）。 */
  skipped: boolean;
};

/**
 * 只靠一个 sessionid 拼出的最小 cookie 集。
 *
 * 实测只写 `sessionid` 一条就能认证；`sessionid_ss` / `sid_tt` 一起带上更稳妥
 * （豆包侧 `sid_tt` 恒等于 `sessionid`）。其余 cookie（ttwid、csrf 等）不伪造，
 * 由浏览器访问站点时自行补回来。
 */
function sessionCookies(sessionId: string, domain: string): ImportedCookie[] {
  const host = domain.startsWith(".") ? domain : `.${domain}`;
  const secure = true;
  return [
    { name: "sessionid", value: sessionId, domain: host, path: "/", secure, httpOnly: true, sameSite: "no_restriction" },
    { name: "sessionid_ss", value: sessionId, domain: host, path: "/", secure, httpOnly: true, sameSite: "no_restriction" },
    { name: "sid_tt", value: sessionId, domain: host, path: "/", secure, httpOnly: false, sameSite: "no_restriction" },
  ];
}

/** 问豆包「当前这份登录态是谁」—— 顺带验证 sessionid 有效，并拿到昵称。 */
async function fetchDoubaoIdentity(context: any): Promise<{ userId: string; name: string } | null> {
  try {
    const response = await context.request.get("https://accounts.doubao.com/passport/account/info/", {
      headers: { Referer: "https://www.doubao.com/" },
      timeout: 20000,
    });
    const body: any = await response.json();
    const data = body?.data;
    if (!data?.user_id) return null;
    return { userId: String(data.user_id), name: String(data.screen_name || "").trim() };
  } catch {
    return null;
  }
}

/**
 * 读一个 profile 当前的登录身份（升级兼容用，见 importCookies 里的对齐步骤）。
 * 读不到就返回空，不抛。
 */
export async function readProfileIdentity(
  profileDir: string,
  executableOverride?: string,
): Promise<{ sessionId: string; userId: string; name: string }> {
  const empty = { sessionId: "", userId: "", name: "" };
  try {
    // ⚠️ **必须用账号自己的内核**打开这个 profile（2026-10-15 修）。
    //    cookie 的加密密钥绑定具体浏览器：拿全局兜底（默认 Chrome）去开 Edge 建的 profile，
    //    不但读不出登录态，还可能把 profile 的加密绑定写坏 —— 实测同步 Edge 账号时
    //    日志里冒出「浏览器内核：Chrome」，就是这个默认值漏下来了。
    const context = await launchContext(profileDir, true, executableOverride);
    try {
      const cookies = await context.cookies(ACCOUNT_PLATFORMS.doubao.url);
      const sessionId = String((cookies as any[]).find((c) => c.name === "sessionid")?.value ?? "").trim();
      if (!sessionId) return empty;
      const identity = await fetchDoubaoIdentity(context);
      return { sessionId, userId: identity?.userId ?? "", name: identity?.name ?? "" };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch {
    return empty;
  }
}

/**
 * 把一个「浏览器里的登录态」落成账号池里的一个账号。
 *
 * 传了完整 cookies 时原样写入（保真度最高）；只给了 sessionId 时用最小 cookie 集，
 * 并让浏览器去站点走一趟把辅助 cookie 补回来（多账号场景）。
 */
async function importOneAccount(input: {
  accountType: AccountType;
  name?: string;
  uid?: string;
  sessionId?: string;
  cookies?: ImportedCookie[];
  /** 「这份登录态是从哪个浏览器拿来的」—— 记到账号上，以后就用它启动（见 launchContext）。 */
  browser?: string;
}): Promise<ImportedAccountResult> {
  const type = input.accountType;
  const platform = ACCOUNT_PLATFORMS[type];
  const incoming = input.cookies ?? [];
  const sessionId =
    input.sessionId || String(incoming.find((item) => String(item.name) === "sessionid")?.value ?? "").trim();

  const fingerprint = sessionId ? sessionFingerprint(sessionId) : loginFingerprint(incoming);

  // ⚠️ 必须去重：扩展在 cookie 变动时推一次、另有每 5 分钟兜底推一次，浏览器里还可能
  // 有多个账号 —— 每次都 addAccount 会把账号池撑爆。
  // 优先按平台 uid 认人（重登同一个号不会多出一个），没有 uid 才退回指纹。
  const all = await loadAccounts();
  const existing =
    (input.uid ? all.find((a) => a.accountType === type && a.doubaoUid && a.doubaoUid === input.uid) : undefined) ??
    (fingerprint ? all.find((a) => a.accountType === type && a.sessionFingerprint === fingerprint) : undefined);

  // 同一个账号、同一份登录态、上次已确认登录有效 ⇒ 直接跳过。
  // 不跳过的话，扩展每 5 分钟兜底推一次就会反复拉起浏览器（每账号要跑一趟站点），白耗。
  if (existing && fingerprint && existing.sessionFingerprint === fingerprint && existing.hasLoggedIn) {
    return {
      id: existing.id,
      name: existing.name,
      uid: existing.doubaoUid || input.uid || "",
      loggedIn: true,
      created: false,
      accepted: 0,
      skipped: true,
    };
  }
  const account = existing ?? (await addAccount(input.name, type));

  const context = await launchContext(account.profileDir, true, input.browser);
  try {
    const mapped = (incoming.length ? incoming : sessionCookies(sessionId, platform.domain))
      .map(toPlaywrightCookie)
      .filter((item): item is Record<string, unknown> => Boolean(item));

    // 整体写最快；个别条目不被接受时退回逐条写 —— 别让一条坏 cookie 毁掉整次导入。
    try {
      if (mapped.length) await context.addCookies(mapped as any);
    } catch {
      for (const cookie of mapped) await context.addCookies([cookie] as any).catch(() => undefined);
    }

    // 只给了 sessionid 时，让浏览器去站点走一趟，把 ttwid / csrf 等辅助 cookie 补回来。
    if (!incoming.length) {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(platform.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
    }

    const identity = await fetchDoubaoIdentity(context);
    const loggedIn = Boolean(identity?.userId);
    const finalName = input.name?.trim() || identity?.name || "";
    await setAccountIdentity(account.id, {
      uid: input.uid || identity?.userId || "",
      fingerprint,
      name: finalName,
      hasLoggedIn: loggedIn,
      // 记下建这个 profile 用的内核：生成时按它启动，别让账号跨内核打开（会读不出 cookie）。
      browser: input.browser,
    });
    log(
      `从浏览器${existing ? "更新" : "导入"}账号「${finalName || account.name}」` +
        `(@${identity?.userId || input.uid || "?"})：写入 ${mapped.length} 条，` +
        `登录态${loggedIn ? "有效" : "**无法确认**"}`,
    );
    return {
      id: account.id,
      name: finalName || account.name,
      uid: identity?.userId || input.uid || "",
      loggedIn,
      created: !existing,
      accepted: mapped.length,
      skipped: false,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function importCookies(request: {
  cookies?: ImportedCookie[];
  name?: string;
  accountType?: string;
  /** 浏览器里登录的**全部**账号（`multi_sids` 解析结果）。有值就以它为准，逐个建号。 */
  browserAccounts?: BrowserAccount[];
  /** `multi_sids` 原始值（仅日志 / 诊断用）。 */
  multiSidsRaw?: string;
  /** 这份登录态是从哪个浏览器读来的（`GET /browsers` 的 executable）—— 建 profile 与后续生成都用它。 */
  browser?: string;
}): Promise<{ accounts: ImportedAccountResult[]; created: number; updated: number; raw: string }> {
  const type = normalizeAccountType(request.accountType);
  const incoming = Array.isArray(request.cookies) ? request.cookies : [];
  const listed = (Array.isArray(request.browserAccounts) ? request.browserAccounts : []).filter(
    (item): item is BrowserAccount => Boolean(item && item.sessionId),
  );

  // 空包就别建账号了 —— 否则账号池里会多出一个永远登录不上的空壳。
  if (!incoming.length && !listed.length) {
    throw new Error("没有收到任何 cookie（请确认已在浏览器里登录豆包）");
  }

  // 多账号：以清单为准逐个建号。清单里跟「当前生效 sessionid」相同的那一个，
  // 把完整 cookies 一并写给它（保真度最高）；其余用最小集 + 访问站点补齐。
  if (listed.length) {
    const currentSessionId = String(incoming.find((item) => String(item.name) === "sessionid")?.value ?? "").trim();

    // 升级兼容：升级前建的账号记录没有 uid / 指纹，先按它们**各自 profile 里的 sessionid**
    // 对齐一次，免得同一个号多出一份。只对「两样都空」的老记录做，对齐后它就带指纹了，
    // 下次同步直接跳过（不会反复读 profile）。
    const blanks = (await loadAccounts()).filter(
      (a) => a.accountType === type && !a.doubaoUid && !a.sessionFingerprint,
    );
    for (const blank of blanks) {
      // ⚠️ 用**这个老账号自己记着的内核**去读（空则退回全局兜底 —— 而兜底现在会被
      //    `browsers/sync` 写成「用户同步时用的那个浏览器」，不会再莫名变成 Chrome）。
      const profile = await readProfileIdentity(blank.profileDir, blank.browser);
      if (!profile.sessionId) continue;
      const hit = listed.find((item) => item.sessionId === profile.sessionId);
      if (!hit) continue;
      await setAccountIdentity(blank.id, {
        uid: hit.uid || profile.userId,
        fingerprint: sessionFingerprint(profile.sessionId),
        name: profile.name,
        hasLoggedIn: Boolean(profile.userId),
      });
      log(`老账号记录 ${blank.id} 对齐到「${profile.name || "?"}」(@${hit.uid || profile.userId || "?"})`);
    }

    const results: ImportedAccountResult[] = [];
    for (const item of listed) {
      results.push(
        await importOneAccount({
          accountType: type,
          name: listed.length === 1 ? request.name : undefined,
          uid: item.uid,
          sessionId: item.sessionId,
          cookies: item.sessionId === currentSessionId ? incoming : undefined,
          browser: request.browser,
        }),
      );
    }
    return {
      accounts: results,
      created: results.filter((item) => item.created).length,
      updated: results.filter((item) => !item.created).length,
      raw: String(request.multiSidsRaw ?? ""),
    };
  }

  // 兜底：没解析出清单时，按「当前这一份完整登录态」建号（老行为）。
  const result = await importOneAccount({ accountType: type, name: request.name, cookies: incoming, browser: request.browser });
  return { accounts: [result], created: result.created ? 1 : 0, updated: result.created ? 0 : 1, raw: "" };
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
  // 用**这个账号自己记着的内核**启动：从 Edge 同步来的号就用 Edge，别跨内核
  // （cookie 加密绑定浏览器，跨内核读不出来 ⇒ 又会弹登录窗要用户重新扫码）。
  const accountBrowser = String((request as any)?.browser || "");
  const context = await launchContext(profileDir, false, accountBrowser || undefined);

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

    // ── 去水印（链路里的一道自动工序）──────────────────────────────────
    // 两级策略，**优先无损**：
    //  ① **平台原片（fplay）**：地址嵌在会话消息 JSON 里，靠生成过程中扫响应体截获。
    //     取 `logo_type` 为空的档 → AES 解密 → 地址不含 watermark。实测这条路的成品
    //     **完全没有水印**（左上、右下都干净），而且是无损原编码 ⇒ **首选**。
    //     ⚠️ 别再拿 get_play_info 的 original_media_info 当原片 —— 实测它与抓取版
    //     逐像素相同（同一个带水印文件），那条路是死的。
    //  ② 拿不到 fplay（没截获到 / 解密失败）→ 退回**像素修复**（deshadowVideo：
    //     有 OpenCV 走 inpaint，否则 ffmpeg delogo），有损但不至于把成片卡住。
    let handled = false;
    if (accountType === "doubao" && fplayApis.size) {
      const original = await resolveOriginalViaFplay(context, [...fplayApis]).catch(() => null);
      if (original) {
        try {
          const response = await context.request.get(original.url, { timeout: 120000 });
          const body = await response.body();
          if (response.ok() && body && body.length > 50_000) {
            const archived = outputPath.replace(/\.mp4$/, ".抓取版.mp4");
            await writeFile(archived, videoBytes);
            await writeFile(outputPath, body);
            videoBytes = new Uint8Array(body);
            handled = true;
            log(
              `已换用平台原片（${original.definition} ${original.label}，${(body.length / 1048576).toFixed(1)} MB）` +
                `｜无水印，抓取版存档 ${archived}`,
            );
          } else {
            log(`原片下载不完整（HTTP ${response.status?.() ?? "?"}），转像素修复`);
          }
        } catch (error) {
          log(`原片下载失败，转像素修复：${String(error).slice(0, 120)}`);
        }
      } else {
        log(`未能从 fplay 解析出原片（截获 ${fplayApis.size} 条），转像素修复`);
      }
    } else {
      log(`未截获 fplay 地址（${fplayApis.size} 条），转像素修复`);
    }
    if (!handled) {
      const deshadow = await deshadowVideo(outputPath, log);
      if (deshadow.applied) {
        log(`像素去水印完成（${deshadow.method}）：${deshadow.detail}`);
      } else {
        log(`水印未处理，保留原始成片：${deshadow.detail}`);
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
