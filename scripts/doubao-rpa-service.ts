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
 *   GET    /health              服务状态
 *   GET    /accounts            账号列表（含平台、今日已用/剩余额度）
 *   POST   /accounts            新增账号并扫码登录   body { name, accountType: "doubao" | "dola" }
 *   POST   /accounts/:id/login  重新扫码登录
 *   DELETE /accounts/:id        删除账号
 *   POST   /generate            生成视频（自动选号，返回 base64）
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
  today,
  usedToday,
  type AccountType,
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

/** 新增账号：创建记录 → 打开对应平台的浏览器窗口扫码。 */
async function createAccount(
  name?: string,
  accountType: AccountType = "doubao",
): Promise<{ ok: boolean; error?: string; id?: string; name?: string; accountType?: AccountType }> {
  if (running) return { ok: false, error: "生成任务执行中，无法同时扫码登录" };
  running = true;
  try {
    const type = normalizeAccountType(accountType);
    const account = await addAccount(name, type);
    await log(`新增账号「${account.name}」（${ACCOUNT_PLATFORMS[type].label}），打开扫码窗口…`);
    const core = await loadCore();
    // 平台必须一路传到核心：站点地址、登录判据、页面控件都按它分支
    await core.openLogin(account.profileDir, type);
    await markLoggedIn(account.id, true);
    await log(`账号「${account.name}」登录成功`);
    return { ok: true, id: account.id, name: account.name, accountType: type };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`新增账号失败：${message}`);
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
    const core = await loadCore();
    await core.openLogin(account.profileDir, account.accountType);
    await markLoggedIn(account.id, true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
refresh();
setInterval(refresh, 5000);
`;

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

    const loginMatch = /^\/accounts\/([^/]+)\/login$/.exec(pathname);
    if (loginMatch && request.method === "POST") {
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
await log(`  账号列表    GET  /accounts`);
await log(`  新增账号    POST /accounts`);
await log(`  生成视频    POST /generate`);
