/**
 * 豆包 RPA 服务 —— 把「浏览器自动化」从 Toonflow 的供应商沙箱里搬出来。
 *
 * 为什么要单独一个进程：
 * Toonflow 的供应商运行在 `node:vm` 沙箱里，官方刻意禁止 import
 * （`loadMediaProviderSource` 的 linker 直接抛「供应商不能导入模块」），
 * 沙箱只提供 `this.tool.fetch / hash / errorMessage / image / audio / ffmpeg`。
 * 而豆包只能靠 Playwright 驱动真实浏览器，沙箱里既没有 playwright，
 * 也拿不到 fs / path / os / process。因此：
 *
 *   画布 → Toonflow → 沙箱供应商（零 import，只发一次 HTTP）
 *        → 本服务（完整 Node 能力）→ Playwright → 豆包网页 → 成片
 *
 * 多账号：豆包按账号给每日免费额度。本服务维护账号池（每个账号独立 profile），
 * 额度用尽自动换号 —— 与 CDTV（JinyuTV）同一套做法，见 scripts/doubao-accounts.ts。
 *
 * 用法：
 *   bun run scripts/doubao-rpa-service.ts            # 启动服务
 *   bun run scripts/doubao-rpa-service.ts --login    # 只打开扫码窗口新增账号
 *
 * 接口（都绑在 127.0.0.1:18077）：
 *   GET    /                    账号管理页
 *   GET    /extension           「豆包账号桥」扩展安装引导页（含 crx 下载）
 *   GET    /health              服务状态
 *   GET    /accounts            账号列表（含平台、今日已用/剩余额度）
 *   POST   /accounts            新增账号并扫码登录   body { name, accountType: "doubao" | "dola" }
 *                               ⚠️ 这是个**长请求**（登录窗一直开着，最长 10 分钟）；
 *                               客户端应轮询 GET /accounts 判断是否登录成功，用
 *                               POST /accounts/cancel-login 打断，或
 *                               POST /accounts/finish-login 让用户点「完成」立刻收工。
 *                               ⭐ 会把登录窗里**所有**已登录豆包账号一次全收进来
 *                               （豆包支持一个浏览器登多个账号）。
 *   POST   /accounts/cancel-login    取消正在进行的扫码登录（关掉等待，释放忙碌状态）
 *   POST   /accounts/finish-login    用户点「完成」：立刻读取登录窗里的账号并落库
 *   POST   /accounts/import-cookies  用「豆包账号桥」扩展送来的 cookie 建账号（不扫码）
 *        body { name, accountType, cookies: chrome.cookies.Cookie[], browserAccounts, multiSidsRaw }
 *        browserAccounts = multi_sids 解析出的全部账号 ⇒ 一次把浏览器里的多个账号都建出来
 *   GET    /browsers            本机装着的浏览器（含"是否正在运行""是否登录过豆包"）
 *   POST   /browsers/sync       从指定浏览器读已登录的豆包账号  body { id }
 *        ⚠️ 该浏览器必须已退出；无头启动一次读 NetLog 里的 Cookie，读完即删日志
 *   POST   /browsers/close      彻底退出指定浏览器（含后台常驻进程） body { id }
 *        关窗口往往不够：Edge 默认开着「启动增强 / 后台扩展」，会留一堆进程占着登录数据
 *   POST   /accounts/:id/login  重新扫码登录
 *   DELETE /accounts/:id        删除账号
 *   POST   /generate            生成视频（自动选号，返回 base64）
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ACCOUNT_PLATFORMS,
  accountsFilePath,
  addAccount,
  isBusy,
  loadAccounts,
  markBusy,
  markLoggedIn,
  markQuotaExhausted,
  normalizeAccountType,
  pickAccount,
  platformOf,
  recordSuccess,
  releaseBusy,
  remainingQuota,
  removeAccount,
  setAccountIdentity,
  today,
  usedToday,
  type AccountType,
  type DoubaoAccount,
} from "./doubao-accounts.ts";

const PORT = Number(process.env.DOUBAO_RPA_PORT || 18077);
const HOST = "127.0.0.1";
const LOG_FILE = resolve(process.cwd(), "assets", "doubao-rpa.log");

async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    await mkdir(resolve(process.cwd(), "assets"), { recursive: true });
    await appendFile(LOG_FILE, line + "\n", "utf-8");
  } catch { /* 日志失败不影响主流程 */ }
}

/** 动态载入 RPA 实现（它不依赖沙箱的 this.tool，可被原生 import）。 */
async function loadCore(): Promise<any> {
  return import("./doubao-rpa-core.ts");
}

/** RPA 必须串行：同一个浏览器 profile 不能并发打开，且豆包会风控。 */
let running = false;

/** 豆包提示额度用尽的文案。 */
const RE_QUOTA = /额度不足|额度已用完|今日.*额度|quota/i;

type GenerateResult =
  | { ok: true; base64: string; mimeType: string; file: string; elapsedSeconds: number; account: string }
  | { ok: false; error: string };

/**
 * 生成入口：自动选号 → 若失败原因是「额度耗尽」，标记该账号并换号重试。
 */
async function generate(payload: any): Promise<GenerateResult> {
  if (running) {
    return { ok: false, error: "已有生成任务在执行中，请稍后再试（浏览器无法并行）" };
  }
  running = true;
  const startedAt = Date.now();
  let lastNote = "";

  try {
    if (!payload?.prompt || !String(payload.prompt).trim()) {
      return { ok: false, error: "缺少提示词" };
    }

    // 最多换 2 个账号再试
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const picked = await pickAccount();
      if ("error" in picked) {
        return { ok: false, error: lastNote ? `${lastNote}；${picked.error}` : picked.error };
      }
      const account = picked.account;
      markBusy(account.id);
      try {
        const platform = platformOf(account);
        await log(`[账号 ${account.name} · ${platform.label}] 开始生成（第 ${attempt} 次）：${String(payload.prompt).slice(0, 36)}`);
        const core = await loadCore();
        const assets = await core.default.generateVideo({
          mediaType: "video",
          model: String(payload.model || "Seedance 2.0 Fast"),
          prompt: String(payload.prompt),
          images: Array.isArray(payload.images) ? payload.images : [],
          ratio: payload.ratio ? String(payload.ratio) : undefined,
          duration: payload.duration ? Number(payload.duration) : undefined,
          profileDir: account.profileDir,
          // 用**这个账号自己记着的内核**生成（从 Edge 同步来的号就用 Edge）。
          // 不传的话会退回全局选择，跨内核读不出 cookie ⇒ 又弹登录窗要用户重新扫码。
          browser: account.browser,
          // 平台一路传到核心：由它决定打开哪个站点、用哪套页面控件
          accountType: account.accountType,
        });

        const asset = Array.isArray(assets) ? assets[0] : assets;
        const url = String(asset?.url || "");
        if (!url.startsWith("file://")) throw new Error(`供应商未返回本地成片路径：${url || "（空）"}`);
        const filePath = decodeURIComponent(url.slice("file://".length));
        const bytes = await readFile(filePath);
        await recordSuccess(account.id);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        await log(`[账号 ${account.name}] 生成完成：${filePath}（${(bytes.length / 1048576).toFixed(1)} MB，耗时 ${elapsed}s）`);
        return {
          ok: true,
          base64: Buffer.from(bytes).toString("base64"),
          mimeType: asset?.mimeType || "video/mp4",
          file: filePath,
          elapsedSeconds: elapsed,
          account: account.name,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (RE_QUOTA.test(message)) {
          await markQuotaExhausted(account.id);
          lastNote = `账号「${account.name}」今日额度已用完`;
          await log(`${lastNote}，换下一个账号`);
          continue;
        }
        await log(`[账号 ${account.name}] 生成失败：${message}`);
        return { ok: false, error: message };
      } finally {
        releaseBusy(account.id);
      }
    }
    return { ok: false, error: `${lastNote}，且没有其他可用账号。请在账号管理页新增：http://127.0.0.1:${PORT}/` };
  } finally {
    running = false;
  }
}

/**
 * 当前正在进行的扫码登录（用于「取消」）。
 *
 * 为什么必须有：`openLogin()` 最长会等 10 分钟，期间 `running` 一直是 true。
 * 用户点了取消却没人通知服务端的话，他要等满 10 分钟才能再点一次 —— 体验是坏的。
 */
let loginAbort: AbortController | null = null;
/** 用户在界面上点了「完成」—— 让登录等待立刻收工并把登录态交出去。 */
let loginFinish = false;

/**
 * 打开登录窗并等它登录完成，返回捞到的登录态（**含窗口里登录的全部豆包账号**）。
 *
 * 可被 `/accounts/cancel-login` 打断，也可被 `/accounts/finish-login` 提前收工。
 */
async function runLogin(profileDir: string, accountType: AccountType, browser?: string): Promise<any> {
  const controller = new AbortController();
  loginAbort = controller;
  loginFinish = false;
  try {
    const core = await loadCore();
    return await core.openLogin(profileDir, accountType, {
      signal: controller.signal,
      shouldFinish: () => loginFinish,
      // 重登已有账号时用它自己记着的内核，别换（换内核会把原登录态写废）。
      browser,
    });
  } finally {
    loginAbort = null;
    loginFinish = false;
  }
}

/**
 * 新增账号：打开登录窗扫码。
 *
 * ⭐ 关键：豆包**支持一个浏览器登多个账号**（窗口里的「更多账号 → 添加账号」），
 * 所以这里不是「扫一个建一个」，而是**把登录窗里的全部账号一次全收进来** ——
 * 跟「从本机浏览器拉取」走完全相同的落库路径（`importCookies`），行为一致。
 */
async function createAccount(
  name?: string,
  accountType: AccountType = "doubao",
): Promise<{
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
  accountType?: AccountType;
  /** 本次一共收进几个账号（含登录窗里额外登录的）。 */
  total?: number;
}> {
  if (running) return { ok: false, error: "生成任务执行中，无法同时扫码登录" };
  running = true;
  const type = normalizeAccountType(accountType);
  let account: DoubaoAccount | null = null;
  let core: Awaited<ReturnType<typeof loadCore>> | null = null;
  try {
    // 先建一条记录：登录窗就用它的 profile，登录态直接留在里面，不用来回搬。
    account = await addAccount(name, type);
    await log(`新增账号「${account.name}」（${ACCOUNT_PLATFORMS[type].label}），打开登录窗口…`);
    // 平台必须一路传到核心：站点地址、登录判据、页面控件都按它分支
    core = await loadCore();
    const captured = await runLogin(account.profileDir, type);
    if (!captured?.sessionId) throw new Error("没读到豆包登录态，请重试");

    // 当前这个号 → 就用刚建的记录（登录态已经在它的 profile 里了）。
    const me = (captured.browserAccounts ?? []).find((item: any) => item.sessionId === captured.sessionId);
    // 记下这次用的是哪个内核：以后生成/重登都按它来，客户不用再扫码。
    const kernel = core.currentBrowser();
    await setAccountIdentity(account.id, {
      uid: captured.userId || me?.uid || "",
      fingerprint: captured.fingerprint,
      name: captured.nickname,
      hasLoggedIn: true,
      browser: kernel,
    });

    // 窗口里还登了别的号 → 一并收进来（豆包多账号）。
    const extra = (captured.browserAccounts ?? []).filter((item: any) => item.sessionId !== captured.sessionId);
    let others: string[] = [];
    if (extra.length) {
      const imported = await core.importCookies({ cookies: [], accountType: type, browserAccounts: extra, browser: kernel });
      others = (imported?.accounts ?? []).map((item: any) => item.name);
      await log(`登录窗口里还登录了 ${others.length} 个豆包账号：${others.join("、")} —— 已一并加入`);
    }
    const total = 1 + others.length;
    await log(`账号「${captured.nickname || account.name}」登录成功（本次共收进 ${total} 个账号）`);
    return { ok: true, id: account.id, name: captured.nickname || account.name, accountType: type, total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`新增账号未完成：${message}`);
    // ⚠️ 别在账号池里留一个永远登录不上的空壳：先确认 profile 里**确实没有**登录态，
    // 再把刚建的这条记录删掉。（首次引导时用户点了取消，账号池必须保持干净。）
    if (account) {
      let sessionId = "";
      try {
        sessionId = (await (core ?? (await loadCore())).readProfileIdentity(account.profileDir, account.browser)).sessionId;
      } catch { /* 读不到就按没登录处理 */ }
      if (sessionId) {
        await markLoggedIn(account.id, true);
        await log(`账号「${account.name}」其实已经登录成功，保留`);
        return { ok: true, id: account.id, name: account.name, accountType: type, total: 1 };
      }
      await removeAccount(account.id);
      // profile 目录也一起删掉（是这次刚建的），别在 ~/.toonflow-doubao-accounts 里留垃圾。
      await rm(account.profileDir, { recursive: true, force: true }).catch(() => undefined);
      await log(`已清理没登录成功的新账号「${account.name}」`);
    }
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

async function loginAccount(id: string): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: "生成任务执行中，无法同时扫码登录" };
  running = true;
  try {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) return { ok: false, error: "账号不存在" };
    const captured = await runLogin(account.profileDir, account.accountType, account.browser);
    // 顺手把平台 uid / 昵称刷新一下（重新扫码可能是同一个号的另一份登录态）。
    await setAccountIdentity(account.id, {
      uid: captured?.userId || account.doubaoUid,
      fingerprint: captured?.fingerprint || account.sessionFingerprint,
      name: captured?.nickname || account.name,
      hasLoggedIn: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    running = false;
  }
}

/**
 * 从「用户指定的浏览器」同步已登录的豆包账号。
 *
 * 与扩展 / 登录窗走**完全相同的落库路径**（`importCookies`），只是 cookie 来源不同：
 * 这里是用浏览器自带的 NetLog 把请求头里的 Cookie 取出来（见 core.captureBrowserSession）。
 */
async function syncFromBrowser(id: string): Promise<{
  ok: boolean;
  error?: string;
  browser?: string;
  total?: number;
  created?: number;
  updated?: number;
  accounts?: Array<{ id: string; name: string; uid: string; loggedIn: boolean; created: boolean }>;
}> {
  if (running) return { ok: false, error: "生成任务执行中，同步只占用几秒，请稍后再试" };
  const core = await loadCore();
  const candidate = (core.listBrowserCandidates() as Array<{ id: string; name: string }>).find((item) => item.id === id);
  if (!candidate) return { ok: false, error: "没找到这个浏览器（可能已卸载或路径变了）" };
  running = true;
  try {
    const captured = await core.captureBrowserSession(candidate);
    const result = await core.importCookies({
      cookies: captured.cookies,
      browserAccounts: captured.browserAccounts,
      accountType: "doubao",
      // ★ 用「被同步的那个浏览器」建这些号的 profile，并记到账号上：
      //   以后点生成就用它启动，客户不用再登一次。
      browser: candidate.executable,
    });
    // ★ 顺手把「被同步的这个浏览器」记为**全局兜底内核**（browser.json）。
    //   账号自身记的 `browser` 是第一优先，但老账号可能没这个字段（单账号模式迁移来的），
    //   那时就会退回全局兜底 —— 而兜底此前固定挑 Chrome，于是出现
    //   「从 Edge 同步的账号，生成时却弹 Chrome」这种诡异现象（2026-10-15 实测定位）。
    core.saveBrowser(candidate.executable);
    const list = result.accounts ?? [];
    await log(
      `从 ${candidate.name} 同步完成：共 ${list.length} 个账号（新增 ${result.created}、更新 ${result.updated}）`,
    );
    return {
      ok: true,
      browser: candidate.name,
      total: list.length,
      created: result.created,
      updated: result.updated,
      accounts: list.map((a: any) => ({ id: a.id, name: a.name, uid: a.uid, loggedIn: a.loggedIn, created: a.created })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`从 ${candidate.name} 同步失败：${message}`);
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

/**
 * 用浏览器扩展送来的 cookie 建账号（不用扫码）。
 *
 * 数据来源是本机浏览器的「豆包账号桥」扩展（tools/doubao-cookie-bridge/）：
 * 它读浏览器自己的 cookie store，能拿到 HttpOnly 的 sessionid —— 这是绕开
 * Chromium App-Bound 加密的唯一零特权路径。
 *
 * ⚠️ 多账号：扩展除全量 cookie 外，还会把 `multi_sids`（`<uid>:<sessionid>` 清单）
 * 一起送来。豆包网页端本来就支持一个浏览器登多个账号并切换，这里按清单**逐个建号**，
 * 不再是「一个浏览器只同步出一个账号」。
 */
async function importCookiesAccount(body: {
  cookies?: unknown;
  name?: unknown;
  accountType?: unknown;
  /** 浏览器里登录的全部账号（multi_sids 解析结果）。 */
  browserAccounts?: unknown;
  /** multi_sids 原始值，仅日志 / 诊断用。 */
  multiSidsRaw?: unknown;
}): Promise<{
  ok: boolean;
  error?: string;
  /** 本次同步到的全部账号。 */
  accounts?: Array<{ id: string; name: string; uid: string; loggedIn: boolean; created: boolean }>;
  total?: number;
  created?: number;
  updated?: number;
  /** 兼容老调用方：第一个账号的信息。 */
  id?: string;
  name?: string;
  accountType?: AccountType;
  loggedIn?: boolean;
  adopted?: number;
}> {
  if (running) return { ok: false, error: "生成任务执行中，同步只占用几秒，请稍后再试" };
  running = true;
  try {
    const type = normalizeAccountType(body?.accountType);
    const core = await loadCore();
    const result = await core.importCookies({
      cookies: body?.cookies as never,
      name: typeof body?.name === "string" ? body.name : undefined,
      accountType: type,
      browserAccounts: body?.browserAccounts as never,
      multiSidsRaw: typeof body?.multiSidsRaw === "string" ? body.multiSidsRaw : undefined,
    });
    const list = result.accounts ?? [];
    const skipped = list.filter((a) => a.skipped).length;
    await log(
      `从浏览器同步完成：共 ${list.length} 个账号（新增 ${result.created}、更新 ${result.updated}、` +
        `未变 ${skipped}）` +
        (result.raw ? `；multi_sids=${result.raw}` : ""),
    );
    const first = list[0];
    return {
      ok: true,
      accounts: list.map((a) => ({ id: a.id, name: a.name, uid: a.uid, loggedIn: a.loggedIn, created: a.created })),
      total: list.length,
      created: result.created,
      updated: result.updated,
      id: first?.id,
      name: first?.name,
      accountType: type,
      loggedIn: first?.loggedIn,
      adopted: first?.accepted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`从浏览器同步账号失败：${message}`);
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ 管理页 */

const PAGE_STYLE = `
:root { color-scheme: dark; }
body { margin: 0; padding: 32px; background: #0c0e13; color: #e6e9f0;
  font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: #8b93a5; font-size: 13px; margin-bottom: 22px; }
.bar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
input { padding: 8px 12px; border-radius: 8px; border: 1px solid #2b3140;
  background: #14171f; color: #e6e9f0; font-size: 13px; min-width: 200px; }
button { padding: 8px 16px; border-radius: 8px; border: 1px solid #2b3140;
  background: #1b1f2a; color: #cfd6e4; font-size: 13px; cursor: pointer; }
button:hover { background: #232936; }
button.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
button.primary:hover { background: #3d78ff; }
button.danger { color: #ff8b8b; border-color: #4a2a2e; }
table { width: 100%; border-collapse: collapse; background: #101319; border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid #1c212b; font-size: 13px; }
th { color: #8b93a5; font-weight: 500; background: #131720; }
tr:last-child td { border-bottom: none; }
.tag { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; }
.ok { background: rgba(45,190,120,.16); color: #5fd39a; }
.warn { background: rgba(255,170,60,.16); color: #ffc46b; }
.bad { background: rgba(255,90,90,.16); color: #ff8b8b; }
.empty { padding: 26px; text-align: center; color: #8b93a5; background: #101319; border-radius: 12px; }
#msg { margin-left: 6px; color: #7fd1a6; font-size: 13px; }
#msg.err { color: #ff8b8b; }
`;

const PAGE_SCRIPT = `
const msg = document.getElementById("msg");
const show = (text, isErr) => { msg.textContent = text; msg.className = isErr ? "err" : ""; };
const tag = (text, cls) => '<span class="tag ' + cls + '">' + text + '</span>';

async function refresh() {
  const res = await fetch("/accounts").then(r => r.json());
  const list = document.getElementById("list");
  if (!res.accounts.length) {
    list.innerHTML = '<div class="empty">还没有账号。先在上面选平台（豆包 / Dola 海外），再点「新增账号」，在弹出的浏览器里扫码登录即可。</div>';
    return;
  }
  list.innerHTML = '<table><thead><tr><th>账号</th><th>平台</th><th>登录态</th><th>今日已用</th><th>剩余额度</th><th>状态</th><th></th></tr></thead><tbody>'
    + res.accounts.map(a => '<tr>'
      + '<td>' + a.name + '<div style="color:#6f7787;font-size:12px">' + a.id + '</div></td>'
      + '<td>' + (a.platformLabel || "豆包") + '</td>'
      + '<td>' + (a.hasLoggedIn ? tag("已登录", "ok") : tag("未登录", "warn")) + '</td>'
      + '<td>' + a.usedToday + ' / ' + a.dailyQuota + '</td>'
      + '<td>' + a.remaining + '</td>'
      + '<td>' + (a.exhausted ? tag("今日额度已用完", "bad") : (a.busy ? tag("生成中", "warn") : tag("可用", "ok"))) + '</td>'
      + '<td style="text-align:right;white-space:nowrap">'
        + '<button onclick="login(\\'' + a.id + '\\')">扫码登录</button> '
        + '<button class="danger" onclick="remove(\\'' + a.id + '\\')">删除</button>'
      + '</td></tr>').join('')
    + '</tbody></table>';
}

document.getElementById("refresh").onclick = () => refresh();
document.getElementById("add").onclick = async () => {
  const name = document.getElementById("name").value;
  const accountType = document.getElementById("platform").value;
  show("正在打开浏览器，请在弹出的窗口里扫码…（最长 10 分钟）");
  const res = await fetch("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, accountType }) }).then(r => r.json());
  show(res.ok ? "账号已添加：" + (res.name || "") : ("失败：" + (res.error || "")), !res.ok);
  refresh();
};
async function login(id) {
  show("正在打开浏览器，请扫码…");
  const res = await fetch("/accounts/" + id + "/login", { method: "POST" }).then(r => r.json());
  show(res.ok ? "登录成功" : ("失败：" + (res.error || "")), !res.ok);
  refresh();
}
async function remove(id) {
  if (!confirm("确定删除这个账号？")) return;
  await fetch("/accounts/" + id, { method: "DELETE" });
  show("已删除");
  refresh();
}
/* ---------- 浏览器内核（扫码登录 / 生成都跑在它里面） ---------- */
async function loadBrowser() {
  const box = document.getElementById("browserMsg");
  const res = await fetch("/browser").then(r => r.json()).catch(() => null);
  if (!res || !res.ok) { if (box) box.textContent = "读不到浏览器设置"; return; }
  const sel = document.getElementById("browserSel");
  sel.innerHTML = res.candidates.length
    ? res.candidates.map(c => \`<option value="\${c.path}"\${c.path === res.current ? " selected" : ""}>\${c.name}</option>\`).join("")
    : '<option value="">（没找到 Chrome / Edge）</option>';
  if (box) box.textContent = res.source ? "来源：" + res.source : "";
}
async function applyBrowser() {
  const path = document.getElementById("browserSel").value;
  if (!path) return;
  if (!confirm("换浏览器内核会让**已有账号的登录态全部失效**（cookie 加密绑定到具体浏览器），需要重新扫码。确定要换吗？")) return;
  const res = await fetch("/browser", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
  }).then(r => r.json()).catch(() => null);
  const box = document.getElementById("browserMsg");
  if (box) box.textContent = res && res.ok ? "已切换（已有账号可能需要重新扫码）" : ("失败：" + ((res && res.error) || ""));
  loadBrowser();
}
document.getElementById("saveBrowser").addEventListener("click", applyBrowser);
loadBrowser();

refresh();
setInterval(refresh, 5000);
`;

/** 「豆包账号桥」扩展：随安装包分发（tools/ 下），用户从这里加载。 */
const EXTENSION_DIR = resolve(process.cwd(), "tools", "doubao-cookie-bridge");
const EXTENSION_CRX = resolve(process.cwd(), "tools", "doubao-cookie-bridge.crx");

function renderExtensionPage(): string {
  const ready = existsSync(EXTENSION_DIR);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>豆包账号桥 · 安装引导</title><style>${PAGE_STYLE}</style></head>
<body>
<h1>豆包账号桥 —— 一键同步浏览器里已登录的豆包账号</h1>
<div class="sub">装一次扩展，之后浏览器里登录了豆包，登录态会自动同步进来，不必再扫码。<b>数据只在本机 127.0.0.1 传输，不经任何服务器。</b></div>
<div class="card"><h2>为什么必须用扩展</h2>
<div>Chrome / Edge 从 127 版起把浏览器内的 cookie 用「App-Bound 加密」保护起来 —— <b>任何外部程序都读不到</b>（离线解密解不开，复制配置目录还会被判定路径不符而清空 cookie）。扩展运行在浏览器内部、读的是浏览器自己的 cookie 存储，是官方允许的唯一方式。</div></div>
<div class="card"><h2>装到哪个浏览器？</h2>
<div><b>哪个浏览器里登录了豆包，就装到哪个。</b>扩展读的是「它所在那个浏览器」的登录态 —— 装到 A 读不到 B 的，这是浏览器的隔离机制，没有例外。</div>
<div class="tip" style="margin-top:8px">推荐 <b>Edge</b>（Windows 自带、兼容最好）。手机浏览器装不了扩展，手机上登录的账号同步不过来。</div>
</div>
<div class="card"><h2>安装（三步，只需一次）</h2>
<ol>
<li>在浏览器地址栏打开扩展管理页：<code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>）</li>
<li>打开右上角 <b>开发者模式</b></li>
<li>点 <b>加载已解压的扩展程序</b>，选中下面的目录</li>
</ol>
<div class="pathbox"><code id="extdir">${ready ? EXTENSION_DIR : "（未找到扩展目录 —— 本机可能没随安装包分发，请把 tools/doubao-cookie-bridge 拷到安装目录）"}</code><button id="copy">复制路径</button></div>
<div class="tip"><b>其他浏览器</b>：360 / QQ / 搜狗同为 Chromium 内核，做法一样（地址栏同样输 <code>chrome://extensions</code>）；但新版对第三方扩展管得严，若「加载已解压」不可用，先去设置里关掉「扩展程序保护」。<b>夸克 PC 版</b>默认关闭了扩展能力，需要先在设置/实验室里开启「扩展支持」才看得到这个页面。</div>
<div class="tip">也可以试试把 <a href="/extension/crx" download>扩展包（.crx）</a> 直接拖进扩展管理页 —— 部分浏览器版本允许，能省掉第 3 步。</div>
</div>
<div class="card"><h2>用起来</h2>
<div>装好后在浏览器里打开并登录 <code>www.doubao.com</code>，扩展会自动把登录态同步过来；也可以回 <a href="/">账号管理</a> 页查看新增的账号。</div></div>
<script>
document.getElementById('copy').onclick = async () => {
  const text = document.getElementById('extdir').textContent.trim();
  try { await navigator.clipboard.writeText(text); document.getElementById('copy').textContent = '已复制 ✓'; }
  catch { document.getElementById('copy').textContent = '请手动选中复制'; }
};
</script>
</body></html>`;
}

function renderPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>豆包账号管理 · Toonflow</title><style>${PAGE_STYLE}</style></head>
<body>
<h1>账号管理（豆包 / Dola）</h1>
<div class="sub">两个平台都按账号提供每日免费额度。这里可以添加多个账号，生成时自动选用还有额度的那个；某账号额度耗尽会自动标记并换号。绑定 Dola 请选择平台「Dola（海外）」，登录页是 dola.com。</div>
<div class="bar">
  <select id="platform" style="padding:8px 12px;border-radius:8px;border:1px solid #2b3140;background:#14171f;color:#e6e9f0;font-size:13px">
    <option value="doubao">豆包（国内）</option>
    <option value="dola">Dola（海外）</option>
  </select>
  <input id="name" placeholder="账号备注（例如：小号一）" />
  <button class="primary" id="add">＋ 新增账号（打开扫码）</button>
  <button id="refresh">刷新</button>
  <span id="msg"></span>
</div>
<div class="tip" style="margin:10px 0 14px">
  <b>想省掉扫码？</b>浏览器里已经登录了豆包的话，装一次
  <a href="/extension" target="_blank">豆包账号桥扩展</a>，
  之后登录态会自动同步进来（**装哪个浏览器就同步哪个，不需要在这里选**）。
</div>
<div class="bar" style="margin-bottom:14px">
  <span style="font-size:13px;color:#9aa4b5">扫码/生成用的浏览器</span>
  <select id="browserSel" style="padding:8px 12px;border-radius:8px;border:1px solid #2b3140;background:#14171f;color:#e6e9f0;font-size:13px"></select>
  <button id="saveBrowser">应用</button>
  <span id="browserMsg" class="tip" style="margin:0;flex:0 1 auto"></span>
</div>
<div id="list">加载中…</div>
<script>${PAGE_SCRIPT}</script></body></html>`;
}

/* ------------------------------------------------------------------ 服务 */

// `--login`：命令行直接拉起扫码窗口新增账号，供人工操作后退出。
const loginFlagIndex = process.argv.indexOf("--login");
if (loginFlagIndex >= 0) {
  const result = await createAccount(process.argv[loginFlagIndex + 1]);
  console.log(JSON.stringify(result));
  process.exit(0);
}

/**
 * 允许 Toonflow 前端（:3000）跨域访问本服务（:18077），
 * 这样「设置 → 媒体模型 → 豆包账号」里可以直接显示并管理账号。
 */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* ------------------------------------------------- 异步任务（避免长连接被超时掐断） */

/**
 * 出片是「分钟级」任务，绝不能挂在一个长连接上等：
 * HTTP 默认总请求超时 300 秒、本服务 idleTimeout 上限 255 秒，
 * 任何一层掐断都会让「豆包已出片、画布却拿不到结果」。
 * 所以拆成：POST /generate 领任务号 → GET /generate/result 长轮询取结果。
 */
type Job =
  | { id: string; state: "running"; startedAt: number }
  | { id: string; state: "done"; startedAt: number; finishedAt: number; result: GenerateResult };

const jobs = new Map<string, Job>();
/** 完成后保留多久，供客户端取回（也可以延迟取回）。 */
const JOB_TTL_MS = 30 * 60 * 1000;
/** 自测开关：置 1 时 /generate 支持 {selftestSleepMs} 造一个假任务，用于验证轮询链路。 */
const SELFTEST = process.env.DOUBAO_RPA_SELFTEST === "1";

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state === "done" && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function startJob(payload: any): Job {
  const id = crypto.randomUUID();
  const job: Job = { id, state: "running", startedAt: Date.now() };
  jobs.set(id, job);

  const finish = (result: GenerateResult) => {
    jobs.set(id, { id, state: "done", startedAt: job.startedAt, finishedAt: Date.now(), result });
    pruneJobs();
  };

  // 自测：只 sleep 并回一个极小假文件，用来在不起浏览器的情况下验证「轮询 + 取回」链路
  const selftestSleepMs = SELFTEST ? Number(payload?.selftestSleepMs || 0) : 0;
  if (selftestSleepMs > 0) {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, selftestSleepMs));
      finish({ ok: true, base64: Buffer.from("selftest-mp4").toString("base64"), mimeType: "video/mp4", file: "(selftest)", elapsedSeconds: Math.round(selftestSleepMs / 1000), account: "(selftest)" });
    })();
    return job;
  }

  void (async () => {
    let result: GenerateResult;
    try {
      result = await generate(payload);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    finish(result);
  })();
  return job;
}

/** 长轮询：挂起最多 waitSeconds，期间每 500ms 看一次；出片即返回。 */
async function jobResponse(id: string, waitSeconds: number): Promise<Response> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const job = jobs.get(id);
    if (!job) return Response.json({ ok: false, error: "任务不存在或已过期，请重新生成" }, { status: 404 });
    if (job.state === "done") {
      const r = job.result;
      return r.ok
        ? Response.json({ ok: true, state: "done", base64: r.base64, mimeType: r.mimeType, file: r.file, elapsedSeconds: r.elapsedSeconds, account: r.account })
        : Response.json({ ok: false, state: "done", error: r.error });
    }
    if (Date.now() >= deadline) return Response.json({ ok: true, state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255, // 出片要 3 分钟以上，别让连接先超时
  async fetch(request) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    return withCors(await route(request));
  },
});

async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 扩展安装引导页 + 分发（随安装包放在 tools/ 下）
    if (pathname === "/extension") {
      return new Response(renderExtensionPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/extension/path") {
      return Response.json({
        dir: EXTENSION_DIR,
        crx: EXTENSION_CRX,
        exists: existsSync(EXTENSION_DIR),
        crxExists: existsSync(EXTENSION_CRX),
      });
    }
    if (pathname === "/extension/crx" && existsSync(EXTENSION_CRX)) {
      return new Response(new Uint8Array(await readFile(EXTENSION_CRX)), {
        headers: {
          "Content-Type": "application/x-chrome-extension",
          "Content-Disposition": 'attachment; filename="doubao-cookie-bridge.crx"',
        },
      });
    }

    // 本机装了哪些浏览器（给引导页的「选择要同步的浏览器」用）。
    if (pathname === "/browsers" && request.method === "GET") {
      const core = await loadCore();
      return Response.json({ ok: true, browsers: core.listBrowserCandidates() });
    }

    // 从指定的浏览器同步已登录的豆包账号（不需要装扩展）。
    if (pathname === "/browsers/sync" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json(await syncFromBrowser(String(body?.id ?? "")));
    }

    // 用户点「退出并同步」：先把这个浏览器真退干净（含后台常驻进程），再让调用方去同步。
    if (pathname === "/browsers/close" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const core = await loadCore();
      const result = await core.closeBrowser(String(body?.id ?? ""));
      await log(`退出浏览器 ${body?.id}：原有 ${result.killed} 个进程，释放登录数据=${result.freed}${result.error ? `（${result.error}）` : ""}`);
      return Response.json(result);
    }

    // 扫码登录 / 生成跑在哪个浏览器内核里（换内核会让已有登录态失效，界面上要警示）。
    if (pathname === "/browser" && request.method === "GET") {
      const core = await loadCore();
      return Response.json({ ok: true, ...core.browserState() });
    }
    if (pathname === "/browser" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const target = String(body?.path ?? "").trim();
      const core = await loadCore();
      const usable = (core.listInstalledBrowsers() as Array<{ path: string }>).some((item) => item.path === target);
      if (!target || !usable || !existsSync(target)) {
        return Response.json({ ok: false, error: "这个浏览器不在可用列表里（只认本机的 Chrome / Edge）" });
      }
      const before = core.browserState().current as string;
      core.saveBrowser(target);
      await log(`浏览器内核切换：${before || "(未设置)"} → ${target}（已有账号的登录态可能失效，需要重新扫码）`);
      return Response.json({ ok: true, ...core.browserState() });
    }

    if (pathname === "/health") {
      return Response.json({ ok: true, service: "doubao-rpa", busy: running, port: PORT });
    }

    if (pathname === "/accounts" && request.method === "GET") {
      const accounts = await loadAccounts();
      return Response.json({
        today: today(),
        file: accountsFilePath(),
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          accountType: a.accountType,
          platformLabel: platformOf(a).label,
          hasLoggedIn: a.hasLoggedIn,
          usedToday: usedToday(a),
          dailyQuota: a.dailyQuota,
          remaining: remainingQuota(a),
          exhausted: a.quotaExhaustedOn === today(),
          busy: isBusy(a.id),
          lastUsedAt: a.lastUsedAt,
        })),
      });
    }

    if (pathname === "/accounts" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json(await createAccount(body?.name, normalizeAccountType(body?.accountType)));
    }

    // 浏览器扩展送来已登录的 cookie，直接建账号（不用扫码）。
    // 带 browserAccounts 时是「多账号清单」，会一次性把浏览器里登录的账号全部建出来。
    if (pathname === "/accounts/import-cookies" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json(await importCookiesAccount(body ?? {}));
    }

    // 取消正在进行的扫码登录（`POST /accounts` 最长会等 10 分钟，得能打断）。
    if (pathname === "/accounts/cancel-login" && request.method === "POST") {
      if (!loginAbort) return Response.json({ ok: false, error: "当前没有正在进行的扫码登录" });
      loginAbort.abort();
      await log("收到取消请求，已中断扫码登录等待");
      return Response.json({ ok: true });
    }

    // 用户点「完成」：立刻把登录窗里的登录态收下来（想多登几个号就先登完再点）。
    if (pathname === "/accounts/finish-login" && request.method === "POST") {
      if (!loginAbort) return Response.json({ ok: false, error: "当前没有正在进行的扫码登录" });
      loginFinish = true;
      await log("收到「完成」：正在读取登录窗口里的账号…");
      return Response.json({ ok: true });
    }

    const loginMatch = /^\/accounts\/([^/]+)\/login$/.exec(pathname);    if (loginMatch && request.method === "POST") {
      return Response.json(await loginAccount(decodeURIComponent(loginMatch[1])));
    }

    const accountMatch = /^\/accounts\/([^/]+)$/.exec(pathname);
    if (accountMatch && request.method === "DELETE") {
      const removed = await removeAccount(decodeURIComponent(accountMatch[1]));
      return Response.json({ ok: removed });
    }

    if (pathname === "/generate" && request.method === "POST") {
      // 立刻返回任务号，不在这里等出片。
      // 原因：出片要 3～5 分钟，而长连接会被各层超时掐断（HTTP 默认总请求超时 300 秒、
      // 本服务的 idleTimeout 上限 255 秒）。一旦被掐，豆包那边视频已经生成好了，
      // 我们这边却拿不到结果 —— 现象就是「豆包生成成功，画布节点里没有」。
      // 改成异步任务后，每次请求都很短，客户端按秒轮询，出片后几秒内即可取回。
      const payload = await request.json().catch(() => null);
      const job = startJob(payload);
      return Response.json({ ok: true, async: true, jobId: job.id });
    }

    if (pathname === "/generate/result" && request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id") || "";
      // 长轮询：最多挂 wait 秒，一旦出片立刻返回（客户端无需自己 sleep）
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait") || 20), 1), 120);
      return await jobResponse(id, wait);
    }

    return Response.json({ ok: false, error: "未知接口" }, { status: 404 });
}

await log(`豆包 RPA 服务已启动：http://${HOST}:${server.port}`);
await log(`  账号管理页  http://${HOST}:${server.port}/`);
await log(`  扩展安装引导 http://${HOST}:${server.port}/extension`);
await log(`  账号列表    GET  /accounts`);
await log(`  新增账号    POST /accounts`);
await log(`  生成视频    POST /generate`);
