import { basename } from "node:path";
import { file } from "@toonflow/file/bun";
import type { Request } from "express";
import conf from "@/utils/conf";
import { resolveDesktopRuntime } from "@/lib/desktop";
import type { DesktopRuntime, desktopUpdateAttempt, updateSnapshot } from "@/types/desktop";

const RELEASE_BASE = "https://linke.link/jinyutv-update";
/**
 * 更新源（唯一）：自己服务器上的静态托管（nginx 吐文件，见 scripts/_deploy-update-host.py）。
 *
 * 为什么不用 GitHub Releases 直连：软件进程里的 bun fetch **不走系统代理**，而国内
 * 直连 github.com 普遍超时 —— 2026-10-13 实测「检查更新」永远卡到 15s 超时
 * （终端里 curl 能通是因为终端挂了代理，软件进程没有）。托管目录里的文件由
 * release.py 发版时经 sftp 上传，GitHub Releases 仍照常发布，但只作存档用。
 * 清单固定叫 latest.json，**发新版本不需要改客户端任何地址**。
 */
const updateBaseUrls = {
  github: RELEASE_BASE,
};
const updateRuntimeId = crypto.randomUUID();
let cancelledUpdateAttempt: string | undefined;

function getInstallFailure(local: Awaited<ReturnType<DesktopRuntime["updater"]["getLocalInfo"]>>, applyError?: string): updateSnapshot["installFailure"] {
  if (local.channel === "dev") return;
  const attempt = conf.get("desktopUpdateAttempt");
  if (!attempt) return;
  if (typeof attempt !== "object" || ![attempt.attemptId, attempt.runtimeId, attempt.channel, attempt.targetVersion, attempt.targetHash]
    .every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
    || (attempt.failure !== undefined && typeof attempt.failure !== "string")) {
    try { conf.delete("desktopUpdateAttempt"); }
    catch (error) { console.error("清理无效更新核验记录失败：", error); }
    return;
  }
  if (attempt.attemptId === cancelledUpdateAttempt) {
    // 取消时可能遇到短暂写锁；后续只读回查继续清理，不能误报为安装失败。
    try { conf.delete("desktopUpdateAttempt"); }
    catch (error) { console.error("清理已取消更新核验记录失败：", error); }
    return;
  }
  // ACT: 页面刷新不算重启；由进程内标识区分交接中与下一次实际启动。
  if (attempt.runtimeId === updateRuntimeId && !attempt.failure && !applyError) return;
  try {
    Bun.semver.order(attempt.targetVersion, attempt.targetVersion);
  } catch {
    try { conf.delete("desktopUpdateAttempt"); }
    catch (error) { console.error("清理无效更新核验记录失败：", error); }
    return;
  }
  let installedNewerVersion = false;
  try { installedNewerVersion = Bun.semver.order(local.version, attempt.targetVersion) > 0; }
  catch { /* 本地版本异常也属于核验失败，保留合法的更新目标。 */ }
  if (local.channel === attempt.channel && (local.version === attempt.targetVersion && local.hash === attempt.targetHash
    || installedNewerVersion)) {
    try { conf.delete("desktopUpdateAttempt"); }
    catch (error) { console.error("清理已完成更新核验记录失败：", error); }
    return;
  }
  const message = attempt.failure || applyError || "更新重启后的版本或构建号与目标不一致，请下载完整安装包重新安装。";
  if (!attempt.failure) {
    // ACT: 磁盘满或权限异常时，已有目标仍足以显示完整安装指引，补记失败不能阻断状态查询。
    try { conf.set("desktopUpdateAttempt", { ...attempt, failure: message }); }
    catch (error) { console.error("保存更新核验失败信息失败：", error); }
  }
  return {
    attemptId: attempt.attemptId,
    targetVersion: attempt.targetVersion,
    targetHash: attempt.targetHash,
    currentVersion: local.version,
    currentHash: local.hash,
    message,
    downloadUrl: "https://linke.link/jinyutv-update/",
  };
}

interface DesktopState {
  selectedProviderFile?: { token: string; path: string };
  checkingUpdate: boolean;
  downloadingUpdate: boolean;
  applyingUpdate: boolean;
  updateHandoffComplete?: boolean;
  updateError: string;
  checkedBaseUrl?: string;
  lastBaseUrl?: string;
}

export function isValidUpdateUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
}

function getUpdateBaseUrl(): string {
  // 更新源**只有一个**：我们自己的 GitHub Releases。
  // 以前这里有三个选项（official / github / custom），但：
  //   · official 指向上游 Linke 网关，会拿回**别人产品**的版本清单；
  //   · custom 没有实际使用场景，却让用户以为要自己填地址。
  // 历史配置里可能还留着 desktopUpdateSource / desktopUpdateCustomUrl，
  // 现在一律忽略 —— 单一来源也意味着「没有任何配置能改错更新地址」。
  return updateBaseUrls.github;
}

async function withUpdateSource<T>(updater: DesktopRuntime["updater"], updateBaseUrl: string, run: () => Promise<T>) {
  // ACT: 两版 Mac SDK 和 Windows 更新器均返回缓存对象；只在互斥的更新操作期间覆盖地址。
  const info = await updater.getLocalInfo();
  const baseUrl = info.baseUrl;
  info.baseUrl = updateBaseUrl;
  try {
    return await run();
  } finally {
    info.baseUrl = baseUrl;
  }
}

async function assertUpdateVersion(updater: DesktopRuntime["updater"], state: DesktopState) {
  const version = updater.updateInfo()?.version;
  if (!version) return;
  const local = await updater.getLocalInfo();
  if (Bun.semver.order(version, local.version) >= 0) return;
  state.checkedBaseUrl = undefined;
  throw new Error(`更新源版本 ${version} 早于当前版本 ${local.version}，已阻止降级`);
}

function getDesktopState(req: Request): DesktopState {
  return req.app.locals.desktopState ??= { checkingUpdate: false, downloadingUpdate: false, applyingUpdate: false, updateError: "" };
}

export function getDesktopRuntime(req: Request): DesktopRuntime {
  const runtime = resolveDesktopRuntime(req);
  // 走到这里说明中间件已经放行过；真取不到就是配置/环境不对，给明确错误而不是静默崩。
  if (!runtime) throw Object.assign(new Error("此接口仅在桌面客户端中可用"), { status: 404 });
  return runtime;
}

export async function selectProviderFile(req: Request) {
  const path = await getDesktopRuntime(req).selectProviderFile();
  if (!path) return null;
  if (!/\.ts$/i.test(path)) throw Object.assign(new Error("请选择 .ts 供应商文件"), { status: 400 });
  const selected = { token: crypto.randomUUID(), path };
  getDesktopState(req).selectedProviderFile = selected;
  return { token: selected.token, name: basename(path) };
}

export async function readProviderFile(req: Request, token: string) {
  const selected = getDesktopState(req).selectedProviderFile;
  if (!selected || token !== selected.token) throw Object.assign(new Error("请重新选择并授权供应商文件"), { status: 403 });
  const providerFile = file(selected.path);
  if (!(await providerFile.exists())) throw Object.assign(new Error("供应商文件已被移动或删除，请重新选择"), { status: 404 });
  if (providerFile.size > 2 * 1024 * 1024) throw Object.assign(new Error("供应商文件不能超过 2 MB"), { status: 400 });
  return { name: basename(selected.path), source: await providerFile.text(), lastModified: providerFile.lastModified };
}

export async function getDesktopUpdate(req: Request): Promise<updateSnapshot> {
  const { updater } = getDesktopRuntime(req);
  const state = getDesktopState(req);
  const local = await updater.getLocalInfo();
  const { version, channel, hash } = local;
  // ACT: Intel 1.18.1 首次检查前没有状态，旧清单也可能缺少状态字段。
  const update = updater.updateInfo();
  const updateBaseUrl = getUpdateBaseUrl();
  const validUpdate = state.checkedBaseUrl === updateBaseUrl;
  const applyError = state.applyingUpdate && state.updateHandoffComplete ? update?.error : undefined;
  const installFailure = getInstallFailure(local, applyError);
  if (applyError) state.applyingUpdate = false;
  // ACT: 安装失败跨重启保留，不被切换更新源或普通联网错误覆盖。
  const error = installFailure?.message || (state.lastBaseUrl === updateBaseUrl ? state.updateError || (validUpdate ? update?.error || "" : "") : "") || update?.installError || "";
  return {
    version, channel, hash,
    latestVersion: validUpdate ? update?.version || "" : "",
    latestHash: validUpdate ? update?.hash || "" : "",
    // 更新说明与安装包直链来自发布清单（latest.json）——「检测 + 一键下载」用得到。
    downloadUrl: validUpdate ? update?.downloadUrl || "" : "",
    notes: validUpdate ? update?.notes || "" : "",
    error,
    installFailure,
    updateAvailable: !installFailure && validUpdate && (update?.updateAvailable ?? false),
    updateReady: !installFailure && validUpdate && (update?.updateReady ?? false),
    updating: state.downloadingUpdate || state.applyingUpdate,
    canUpdate: typeof updater.downloadUpdate === "function" && typeof updater.applyUpdate === "function",
  };
}

export async function checkDesktopUpdate(req: Request): Promise<void> {
  const { updater } = getDesktopRuntime(req);
  const state = getDesktopState(req);
  if (state.checkingUpdate || state.downloadingUpdate || state.applyingUpdate)
    throw Object.assign(new Error("更新操作正在执行，请稍后再试。"), { status: 409 });
  state.checkingUpdate = true;
  state.updateError = "";
  const updateBaseUrl = getUpdateBaseUrl();
  state.checkedBaseUrl = undefined;
  state.lastBaseUrl = updateBaseUrl;
  try {
    state.updateError = (await withUpdateSource(updater, updateBaseUrl, () => updater.checkForUpdate())).error || "";
    if (!state.updateError) {
      await assertUpdateVersion(updater, state);
      state.checkedBaseUrl = updateBaseUrl;
    }
  } catch (error) {
    state.updateError = String(error);
  } finally {
    state.checkingUpdate = false;
  }
}

export async function downloadDesktopUpdate(req: Request): Promise<void> {
  const { updater } = getDesktopRuntime(req);
  const state = getDesktopState(req);
  if (!updater.downloadUpdate || !updater.applyUpdate)
    throw Object.assign(new Error("当前客户端不支持应用内更新，请下载安装包。"), { status: 400 });
  if (state.checkingUpdate || state.downloadingUpdate || state.applyingUpdate)
    throw Object.assign(new Error("更新操作正在执行，请稍后再试。"), { status: 409 });
  const updateBaseUrl = getUpdateBaseUrl();
  if (state.checkedBaseUrl !== updateBaseUrl)
    throw Object.assign(new Error("更新源已切换，请重新检查更新。"), { status: 400 });
  if (!updater.updateInfo()?.updateAvailable)
    throw Object.assign(new Error("请先检查并确认有可用更新。"), { status: 400 });
  state.downloadingUpdate = true;
  state.updateError = "";
  try {
    await withUpdateSource(updater, updateBaseUrl, () => updater.downloadUpdate!());
    const update = updater.updateInfo();
    if (update?.error || !update?.updateReady) throw new Error(update?.error || "更新包尚未准备完成，请重试。");
    await assertUpdateVersion(updater, state);
  } catch (error) {
    state.updateError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.downloadingUpdate = false;
  }
}

export async function applyDesktopUpdate(req: Request): Promise<void> {
  const { updater } = getDesktopRuntime(req);
  const state = getDesktopState(req);
  if (!updater.downloadUpdate || !updater.applyUpdate)
    throw Object.assign(new Error("当前客户端不支持应用内更新，请下载安装包。"), { status: 400 });
  if (state.checkingUpdate || state.downloadingUpdate || state.applyingUpdate)
    throw Object.assign(new Error("更新操作正在执行，请稍后再试。"), { status: 409 });
  const updateBaseUrl = getUpdateBaseUrl();
  if (state.checkedBaseUrl !== updateBaseUrl)
    throw Object.assign(new Error("更新源已切换，请重新检查更新。"), { status: 400 });
  if (!updater.updateInfo()?.updateReady)
    throw Object.assign(new Error("请先下载更新。"), { status: 400 });
  state.applyingUpdate = true;
  state.updateHandoffComplete = false;
  state.updateError = "";
  let attempt: desktopUpdateAttempt | undefined;
  try {
    await assertUpdateVersion(updater, state);
    const local = await updater.getLocalInfo();
    const target = updater.updateInfo();
    if (!target?.version || !target.hash) throw new Error("更新包缺少目标版本或构建号，请重新下载。");
    attempt = { attemptId: crypto.randomUUID(), runtimeId: updateRuntimeId, channel: local.channel, targetVersion: target.version, targetHash: target.hash };
    // ACT: SDK 可能直接退出进程，必须在交接前写入 app 外的数据目录。
    conf.set("desktopUpdateAttempt", attempt);
    await withUpdateSource(updater, updateBaseUrl, () => updater.applyUpdate!());
    const error = updater.updateInfo()?.error;
    if (error) throw new Error(error);
    state.updateHandoffComplete = true;
    // ACT: 成功后宿主即将退出，保持互斥直到进程结束。
  } catch (error) {
    state.updateError = error instanceof Error ? error.message : String(error);
    // 交接未完成或用户取消时没有发生重启，不留下虚假的重启失败记录。
    if (attempt) {
      cancelledUpdateAttempt = attempt.attemptId;
      // ACT: 短暂写锁仅重试一次，后续查询可补清理；退出前仍不可写时无法跨进程确认取消。
      for (let retry = 0; retry < 2; retry++) {
        try {
          if (conf.get("desktopUpdateAttempt")?.attemptId === attempt.attemptId) conf.delete("desktopUpdateAttempt");
          break;
        } catch (cleanupError) {
          if (retry === 0) await Bun.sleep(100);
          else console.error("清理已取消更新核验记录失败：", cleanupError);
        }
      }
    }
    state.applyingUpdate = false;
    throw error;
  }
}
