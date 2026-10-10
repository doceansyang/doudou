/**
 * 「无原生桌面运行时」场景下的最小更新器 —— 只为「设置 → 关于 → 检查更新」而生。
 *
 * 为什么需要它：
 *   上游把桌面能力（原生文件对话框、剪贴板、更新器…）挂在 ElectroBun 外壳上，
 *   由外壳在启动时写入 `app.locals.desktop`。我们的发行版改用 **NSIS 安装包 +
 *   自写启动器（内嵌 WebView2）**，没有那个外壳 —— 于是 `/api/desktop/*` 一律
 *   404（「此接口仅在桌面客户端中可用」），「检查更新」形同虚设。
 *
 * 这里只实现更新检查真正需要的那几个方法：
 *   · getLocalInfo()    —— 本机版本（读安装目录的 package.json）
 *   · checkForUpdate()  —— 拉取 GitHub Release 上的最新版本清单并比较
 *   · updateInfo()      —— 最近一次检查结果
 *
 * **刻意不实现** downloadUpdate / applyUpdate：安装包由 NSIS 负责，
 * 应用内自更新（下载归档、替换文件、回滚）不在本方案内。
 * 因此服务端算出的 `canUpdate` 为 false，界面会走「下载安装包」而不是「应用内更新」——
 * 与「检测 + 一键下载」的产品决策一致。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopRuntime } from "@/types/desktop";

/** 版本清单文件名。放在 Release 资产里，固定路径 …/releases/latest/download/latest.json */
const MANIFEST_FILE = "latest.json";
/** 清单请求超时：网络不通时要快速失败，而不是把「检查更新」卡住 */
const CHECK_TIMEOUT_MS = 15000;

type Manifest = { version?: unknown; channel?: unknown; hash?: unknown; notes?: unknown; downloadUrl?: unknown };

type UpdateState = {
  version: string;
  hash: string;
  error: string;
  updateAvailable: boolean;
  updateReady: boolean;
  downloadUrl: string;
  notes: string;
};

type LocalInfo = { version: string; channel: string; hash: string; baseUrl: string };

/**
 * `withUpdateSource()`（见 utils/desktop/index.ts）会把「更新源地址」临时写进
 * **getLocalInfo() 返回的那个对象**，再调用 checkForUpdate()。
 * 所以这里必须返回**同一个缓存对象**而不是每次新建 —— 否则写进去的地址读不到，
 * 表现为「切换更新源无效果，永远查默认源」。
 */
let localInfo: LocalInfo | undefined;

let state: UpdateState = { version: "", hash: "", error: "", updateAvailable: false, updateReady: false, downloadUrl: "", notes: "" };

/** 读取本机安装的版本号。 */
function readLocalVersion(): string {
  const candidates = [
    join(process.cwd(), "package.json"),
    process.env.TOONFLOW_DATA_DIR ? join(process.env.TOONFLOW_DATA_DIR, "..", "package.json") : "",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof parsed?.version === "string" && /^\d+\.\d+\.\d+/.test(parsed.version.trim())) return parsed.version.trim();
    } catch {
      // 读不到就试下一个候选；全都读不到才回退，不因为某个路径不存在而中断。
    }
  }
  return process.env.appVersion?.trim() || "0.0.0";
}

/** 语义化版本比较（只取三段数字，够本项目用；不依赖运行时扩展）。 */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function getLocalInfo(): LocalInfo {
  if (!localInfo) {
    const version = readLocalVersion();
    localInfo = { version, channel: "stable", hash: version, baseUrl: "" };
  }
  return localInfo;
}

function updateInfo() {
  return { ...state };
}

async function checkForUpdate(): Promise<{ error?: string }> {
  const info = getLocalInfo();
  const base = info.baseUrl.endsWith("/") ? info.baseUrl : `${info.baseUrl}/`;
  let url: string;
  try {
    url = new URL(MANIFEST_FILE, base).toString();
  } catch {
    const message = "更新源地址无效，请在「更新源」里重新选择。";
    state = { ...state, error: message, updateAvailable: false };
    return { error: message };
  }
  try {
    const response = await fetch(url, {
      // 清单是「最新版指针」，必须绕开缓存，否则刚发的版本检测不到。
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = (await response.json()) as Manifest;
    const latest = typeof manifest?.version === "string" ? manifest.version.trim() : "";
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error("更新清单里没有合法的版本号");
    state = {
      version: latest,
      hash: typeof manifest.hash === "string" && manifest.hash ? manifest.hash : latest,
      error: "",
      updateAvailable: compareVersions(latest, info.version) > 0,
      updateReady: false,
      downloadUrl: typeof manifest.downloadUrl === "string" ? manifest.downloadUrl : "",
      notes: typeof manifest.notes === "string" ? manifest.notes : "",
    };
    return {};
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "请求超时" : error.message) : String(error);
    const message = `无法获取更新信息（${reason}）。请检查网络后重试。`;
    state = { ...state, error: message, updateAvailable: false };
    return { error: message };
  }
}

/** 仅更新可用的运行时；其它原生能力一律不提供（保持原有 404 语义）。 */
function createStandaloneRuntime(): DesktopRuntime {
  const unavailable = (feature: string) => () => {
    throw Object.assign(new Error(`当前桌面外壳不支持${feature}，此接口仅在原生桌面客户端中可用。`), { status: 404 });
  };
  return {
    openUrl: unavailable("打开外部链接"),
    showItemInFolder: unavailable("定位文件"),
    readClipboardText: unavailable("读取剪贴板"),
    writeClipboardText: unavailable("写入剪贴板"),
    selectProviderFile: unavailable("选择供应商文件"),
    selectDirectory: unavailable("选择目录"),
    selectSaveFile: unavailable("另存为"),
    saveFile: unavailable("保存文件"),
    ready: async () => undefined,
    openDevTools: unavailable("开发者工具"),
    updater: { getLocalInfo: async () => getLocalInfo(), updateInfo, checkForUpdate },
  };
}

/**
 * 单例：更新状态与「本机信息」都是进程级的（上游的更新器同样是模块级缓存对象，
 * 因为 `withUpdateSource()` 依赖把更新源地址写进那个对象里）。
 */
let runtime: DesktopRuntime | undefined;

export function getStandaloneRuntime(): DesktopRuntime {
  return (runtime ??= createStandaloneRuntime());
}

/** 是否是我们自己的桌面发行版（start-server.bat 会设置这个环境变量）。 */
export function isDesktopBuild(): boolean {
  return process.env.toonflowDesktop === "1";
}

/** 是否属于更新相关接口（只有这些接口才挂载最小运行时）。 */
export function isUpdatePath(path: string): boolean {
  return path === "/update" || path.startsWith("/update/");
}
