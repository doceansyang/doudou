// JinyuTV 豆包账号桥 —— 扩展侧实现。
//
// 为什么必须走扩展：Chromium 从 127 起对 cookie 库启用 App-Bound 加密（v20），
// 离线拿 DPAPI 解不开；而扩展用的是浏览器**自身的 cookie store**（chrome.cookies），
// 不受 ABE 约束，能读到 HttpOnly 的 sessionid。这是官方支持的唯一零特权路径。
//
// ⚠️ 多账号（2026-10-13 定案）：豆包网页端**支持在同一个浏览器里登录多个账号并切换**
// （头像菜单「更多账号 / 添加账号」）。全部账号的会话 id 都在 `multi_sids` cookie 里，
// 格式 `<uid>:<sessionid>`。所以这里把清单一起解析出来送过去 ——
// **一个浏览器登录了几个豆包账号，就能同步出几个**，不再是一个浏览器只能出一个。
//
// 数据流向只有一条：扩展 → 本机 127.0.0.1 的 JinyuTV 服务。绝不外发。

const BRIDGE = "http://127.0.0.1:18077"; // 本地 RPA 服务（随 JinyuTV 主服务自动启动）
const DOUBAO_DOMAIN = "doubao.com";

/** 取出豆包登录态（read-only，不改动浏览器任何数据）。 */
async function snapshotCookies() {
  const cookies = await chrome.cookies.getAll({ domain: DOUBAO_DOMAIN });
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate ?? null,
  }));
}

/**
 * 解析浏览器里登录的**全部**豆包账号。
 *
 * `multi_sids` 的值形如 `1234567890123456%3A7bebca…`（URL 编码的 `<uid>:<sessionid>`），
 * 多账号时是多个这样的片段拼接在一起。官方没承诺过分隔符，所以这里**不依赖分隔符**，
 * 直接全文捞出所有 `uid:sessionid` 对 —— 豆包改版也不会失配。
 */
function parseBrowserAccounts(raw) {
  let text = String(raw || "").trim();
  if (!text) return [];
  try {
    text = decodeURIComponent(text);
  } catch (error) {
    // 解码失败就按原样匹配（值里可能本来就是裸冒号）
  }
  const out = [];
  const seen = new Set();
  const pattern = /(\d{6,20})\s*[:：]\s*([A-Za-z0-9_-]{16,128})/g;
  let match = pattern.exec(text);
  while (match) {
    if (!seen.has(match[2])) {
      seen.add(match[2]);
      out.push({ uid: match[1], sessionId: match[2] });
    }
    match = pattern.exec(text);
  }
  return out;
}

/** 推送给本机 JinyuTV。返回摘要，便于在扩展界面/日志里显示结果。 */
async function push(reason) {
  try {
    const cookies = await snapshotCookies();
    const hasSession = cookies.some((cookie) => cookie.name === "sessionid");
    const multiSidsRaw = String(cookies.find((cookie) => cookie.name === "multi_sids")?.value || "");
    const browserAccounts = parseBrowserAccounts(multiSidsRaw);
    const response = await fetch(`${BRIDGE}/accounts/import-cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "extension", reason, hasSession, cookies, browserAccounts, multiSidsRaw }),
    });
    const result = await response.json().catch(() => null);
    return {
      ok: response.ok,
      count: cookies.length,
      hasSession,
      browserAccounts: browserAccounts.length,
      synced: result?.total ?? null,
      result,
      reason,
    };
  } catch (error) {
    return { ok: false, count: 0, hasSession: false, browserAccounts: 0, reason, error: String(error) };
  }
}

// 三条触发路径：装好时、浏览器启动时、以及点图标时。
chrome.runtime.onInstalled.addListener(() => void push("installed"));
chrome.runtime.onStartup.addListener(() => void push("startup"));
chrome.action.onClicked.addListener(async () => {
  const result = await push("manual");
  console.log("[JinyuTV] 同步结果：", result);
});

// 豆包 cookie 一变就同步一次（登录/续期/切换账号都会触发），带 1.2s 防抖避免连打。
// 这条比轮询更跟手：用户在浏览器里刚登录完，这边立刻就有。
let debounce = null;
chrome.cookies.onChanged.addListener((info) => {
  const domain = info?.cookie?.domain ?? "";
  if (!domain.includes(DOUBAO_DOMAIN)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void push("cookie-changed"), 1200);
});

// ⚠️ 不能用 setInterval：MV3 的 service worker 会被回收，定时器随之消失。
// 要用 alarms（由浏览器托管，能唤醒 worker）。它只作为兜底，粒度 30s 起。
// 服务端对「没变化的账号」直接跳过，所以这条兜底不会反复拉起浏览器。
chrome.alarms.create("bridge-tick", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-tick") void push("tick");
});
