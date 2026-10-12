import { Router } from "express";
import conf from "@/utils/conf";
import { success } from "@/lib/responseFormat";

/**
 * 「账户余额」—— **只能靠网页登录的用户令牌**读到，sk key 读不到。
 *
 * ## 为什么不用 sk key（2026-10-12 实测，别再试了）
 * | 接口 | 结果 |
 * |---|---|
 * | `GET /v1/dashboard/billing/usage` | 200，`total_usage` 是真数字（**单位：分**） ⇒ 只能算「已用」 |
 * | `GET /v1/dashboard/billing/subscription` | 200，但 `hard_limit_usd: 100000000` 是**写死的占位** |
 * | `GET /api/user/self`、`/api/token/` | **401 `invalid access token`** —— 要的是网页登录的用户令牌 |
 * | `GET /v1/balance` | 404 |
 * 所以「余额」必须走用户令牌：`Authorization: Bearer <access_token>` → `/api/user/self`。
 *
 * ## 令牌怎么来的
 * linke 控制台（SPA）自己的流程是：登录后拿 `{accessToken, session, accessExpiresAt}`，
 * 过期后用 `POST /api/user/auth/refresh`（带 `X-Auth-Session` 或登录 cookie）换新令牌。
 * 我们**读不到** httpOnly cookie，所以由启动器注入到 linke 页面里的一小段脚本当面刷新、
 * 把结果回传到本接口（见 `scripts/launcher.cs` 的注入分支）—— 不碰用户的密码。
 *
 * ## 换算常量（公开接口 `/api/status`，无需鉴权）
 * `quota_per_unit`（默认 500000 = 1 美元）+ `usd_exchange_rate`（7.3）⇒ **¥ = quota ÷ perUnit × rate**。
 */
const LINK_BASE = "https://api.linke.link";
const FALLBACK = { perUnit: 500000, rate: 7.3 };

type StoredSession = { token?: string; tokenExpiresAt?: number; session?: string; savedAt?: number };

function settings() {
  const value = conf.get("settings", {});
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readSession(): StoredSession {
  const value = settings().linkeSession;
  return value && typeof value === "object" && !Array.isArray(value) ? value as StoredSession : {};
}

function writeSession(next: StoredSession) {
  conf.set("settings", { ...settings(), linkeSession: next });
}

/** 只取字符串并去掉 Bearer 前缀 —— 上游字段名不统一，一个提取口收口。 */
function text(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/^Bearer\s+/i, "").trim() : "";
}

/** 从任意形状里挖出第一个非空字符串（上游字段名五花八门，别逐层硬猜）。 */
function digString(source: unknown, keys: readonly string[], depth = 0): string {
  if (depth > 4 || source == null || typeof source !== "object") return "";
  const data = source as Record<string, unknown>;
  for (const key of keys) {
    const hit = text(data[key]);
    if (hit) return hit;
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const hit = digString(value, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return "";
}

function digNumber(source: unknown, keys: readonly string[], depth = 0): number | undefined {
  if (depth > 4 || source == null || typeof source !== "object") return undefined;
  const data = source as Record<string, unknown>;
  for (const key of keys) {
    const value = data[key];
    const hit = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof hit === "number" && Number.isFinite(hit)) return hit;
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const hit = digNumber(value, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** `/api/status` 的换算常量（公开、无鉴权）。取不到就用默认值，绝不因此让余额整个失败。 */
let constants: { perUnit: number; rate: number } | undefined;
async function statusConstants() {
  if (constants) return constants;
  try {
    const response = await fetch(`${LINK_BASE}/api/status`, { signal: AbortSignal.timeout(10_000) });
    const payload = await response.json() as { data?: Record<string, unknown> };
    const perUnit = Number(payload?.data?.quota_per_unit);
    const rate = Number(payload?.data?.usd_exchange_rate);
    constants = {
      perUnit: Number.isFinite(perUnit) && perUnit > 0 ? perUnit : FALLBACK.perUnit,
      rate: Number.isFinite(rate) && rate > 0 ? rate : FALLBACK.rate,
    };
  } catch {
    constants = { ...FALLBACK };
  }
  return constants;
}

type Account = { balance: number; used: number; quota: number; usedQuota: number; name: string };

/** 用用户令牌读 `/api/user/self`，换算成人民币。令牌无效时回 `null`。 */
async function readAccount(token: string): Promise<Account | null> {
  const response = await fetch(`${LINK_BASE}/api/user/self`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    // 留痕：字段名/错误形态以后变了，看这一行就知道上游到底回了什么（脱敏后只留结构）。
    console.warn(`[Linke 余额] /api/user/self HTTP ${response.status}：${raw.slice(0, 300)}`);
    return null;
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return null; }
  const quota = digNumber(payload, ["quota", "remain_quota", "remainQuota", "balance"]);
  if (quota === undefined) {
    console.warn(`[Linke 余额] /api/user/self 里没找到 quota 字段：${raw.slice(0, 300)}`);
    return null;
  }
  const usedQuota = digNumber(payload, ["used_quota", "usedQuota", "used"]) ?? 0;
  const { perUnit, rate } = await statusConstants();
  const money = (value: number) => Math.round(value / perUnit * rate * 1e6) / 1e6;
  return {
    quota,
    usedQuota,
    balance: money(quota),
    used: money(usedQuota),
    name: digString(payload, ["display_name", "displayName", "username", "name"]),
  };
}

/** 用会话（或登录 cookie）换一把新的访问令牌。 */
async function refreshSession(session: string): Promise<StoredSession | null> {
  try {
    const response = await fetch(`${LINK_BASE}/api/user/auth/refresh`, {
      method: "POST",
      headers: { Accept: "application/json", ...(session ? { "X-Auth-Session": session } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      console.warn(`[Linke 余额] /api/user/auth/refresh HTTP ${response.status}：${raw.slice(0, 300)}`);
      return null;
    }
    const payload = JSON.parse(raw) as unknown;
    const token = digString(payload, ["access_token", "accessToken", "token"]);
    if (!token) {
      console.warn(`[Linke 余额] /api/user/auth/refresh 里没找到访问令牌：${raw.slice(0, 300)}`);
      return null;
    }
    const expires = digNumber(payload, ["access_expires_at", "accessExpiresAt", "expires_at", "expiresAt"]);
    return {
      token,
      tokenExpiresAt: expires === undefined ? undefined : expires < 1e12 ? expires * 1000 : expires,
      // 上游若在刷新时给了新的会话号，就换成新的（它可能是一次性/轮转的）。
      session: digString(payload, ["session", "auth_session", "authSession"]) || session,
      savedAt: Date.now(),
    };
  } catch (error) {
    console.warn(`[Linke 余额] 刷新令牌异常：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const router = Router();

/** 读取余额：有令牌就直接读；过期且存着会话就用会话刷新一次。 */
router.get("/balance", async (_req, res) => {
  const stored = readSession();
  if (!stored.token && !stored.session) {
    res.json(success({ ok: false, reason: "no-token" }));
    return;
  }
  let account = stored.token ? await readAccount(stored.token) : null;
  if (!account && stored.session) {
    const refreshed = await refreshSession(stored.session);
    if (refreshed?.token) {
      writeSession(refreshed);
      account = await readAccount(refreshed.token);
    }
  }
  if (!account) {
    // 令牌与会话都失效 ⇒ 清掉，让界面回到「请登录一次」的状态，而不是反复拿死令牌去撞。
    if (stored.token || stored.session) writeSession({});
    res.json(success({ ok: false, reason: "token-expired" }));
    return;
  }
  res.json(success({ ok: true, ...account }));
});

/**
 * 接收启动器注入脚本从 linke 页面回传的登录凭据。
 *
 * 入参是**原样回传**的刷新响应（外加页面可见的 cookie）—— 这里才做字段解析，
 * 页面那侧不解析任何字段名（两头各写一份解析必然漂移）。
 * 必须真的能读到余额才落盘，否则只回一句失败，不留脏数据。
 */
router.post("/session", async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const payload = body.payload;
  const token = digString(payload, ["access_token", "accessToken", "token"]);
  const session = digString(payload, ["session", "auth_session", "authSession"]) || text(body.session);
  if (!token && !session) {
    res.json(success({ ok: false, reason: "no-credential" }));
    return;
  }
  const account = token ? await readAccount(token) : null;
  if (!account) {
    // 令牌读不出余额时，至少把会话留下来 —— 下次刷新可能就好了。
    if (session) writeSession({ session, savedAt: Date.now() });
    res.json(success({ ok: false, reason: token ? "token-rejected" : "no-token" }));
    return;
  }
  const expires = digNumber(payload, ["access_expires_at", "accessExpiresAt", "expires_at", "expiresAt"]);
  writeSession({
    token,
    session,
    tokenExpiresAt: expires === undefined ? undefined : expires < 1e12 ? expires * 1000 : expires,
    savedAt: Date.now(),
  });
  console.log(`[Linke 余额] 已保存登录凭据，余额 ¥${account.balance.toFixed(2)}`);
  res.json(success({ ok: true, ...account }));
});

/** 退出登录：只清本地保存的凭据（不动用户的浏览器登录态）。 */
router.delete("/session", (_req, res) => {
  writeSession({});
  res.json(success({ ok: true }));
});

export default router;
