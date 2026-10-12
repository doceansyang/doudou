#!/usr/bin/env node
/**
 * 插件中转服务（单文件、零依赖）。
 *
 * ## 它解决什么
 * 插件市场原本是 Toonflow 的后端（`api.toonflow.net/v1/plugin/*`），要一把 **Toonflow 的 key**。
 * 把 key 塞进用户安装包等于把凭据发给每个人（扒出来就能用、泄漏了只能靠新版收回）。
 * 所以：**key 只留在这台服务上**，对客户端只暴露我们自己的地址。
 *
 * ## 客户端会怎么用
 * `apps/web/src/lib/tf.ts` 的 `PLUGIN_MARKET_BASE_URL` 指向本服务即可（一行）。
 * 接口形状**与 Toonflow 完全一致**（`POST /v1/plugin/getPlugin` → `{code,data:{list,total}}`），
 * 客户端不用改任何解析逻辑。
 *
 * ## 去品牌（两道）
 * ① **列表**：所有 `link` 改写成走本服务的下载代理（`/v1/plugin/asset/<文件名>?src=…`）——
 *    上游的下载域名是 `toonflow.tos-cn-beijing.volces.com`（**bucket 名就叫 toonflow**），
 *    不改写的话，客户端侧、服务端日志、抓包都能看到这个域名。
 * ② **下载**：客户端拿到改写后的地址 → 本服务去取 → 流式回传。本服务只放行
 *    **火山 TOS 的 `/plugins/` 路径**（严格白名单，否则这就是个开放代理/SSRF 跳板）。
 *
 * ## 为什么列表不能缓存太久
 * 每个 `link` 是**火山 TOS 的预签名地址，有效期只有 1 小时**（实测 `X-Tos-Expires=3600`，
 * 去掉签名立刻 403）。缓存超过 1 小时 = 发出去一堆下不动的死链。
 * 所以只做很短的进程内缓存（默认 30 秒）挡重复请求，而且**缓存的是改写前的原始体** ——
 * 改写要用「本次请求的 host」拼下载地址，缓存改写后的体会把别的域名的地址发出去。
 *
 * ## 配置
 *   TOONFLOW_MARKET_KEY=…            必填；Toonflow 那边的 key（建议单独开一个**没有余额**的账号）
 *   PORT=8787                        可选，默认 8787
 *   CACHE_SECONDS=30                 可选，列表的进程内缓存秒数；设 0 关掉
 *   PROXY_DOWNLOAD=0                 可选，设 0 则**不改写 link**、让客户端直连上游下载域名
 *   PUBLIC_BASE_URL=https://…        可选，本服务的对外地址；不配则按请求的 Host 推断
 *   ASSET_TOKEN_KEY=…                可选，下载地址里源站参数的加密密钥，见 sealSource
 *
 * 运行：TOONFLOW_MARKET_KEY=xxx node server.mjs
 */
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const UPSTREAM = "https://api.toonflow.net";
const KEY = (process.env.TOONFLOW_MARKET_KEY || "").trim();
const PORT = Number(process.env.PORT || 8787);
const CACHE_MS = Math.max(0, Number(process.env.CACHE_SECONDS ?? 30)) * 1000;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const PROXY_DOWNLOAD = process.env.PROXY_DOWNLOAD !== "0";

/** 只转发这两个（其余 `/v1/plugin/*` 一律 404，别把不认识的路径当通用代理用）。 */
const ALLOWED = new Set(["/v1/plugin/getPlugin", "/v1/plugin/toggleCollection"]);
/** 下载代理：`/v1/plugin/asset/<encodeURIComponent(文件名)>?src=<encodeURIComponent(地址)>`。 */
const ASSET_PREFIX = "/v1/plugin/asset/";
/**
 * 下载代理的**白名单**：只认火山 TOS 的 `/plugins/` 资源。
 * ⚠️ 这两条是安全边界 —— 放开就等于给全世界一个免费代理（还能拿去打内网，SSRF）。
 */
const ASSET_HOST = /(^|\.)tos-[a-z0-9-]+\.volces\.com$/i;
const ASSET_PATH = /^\/plugins\//;

/**
 * 下载地址里的「源站」怎么带出去。
 *
 * 明文 `?src=https://toonflow.tos-…volces.com/…` 虽然功能没问题，但**抓包就能看见上游域名**，
 * 等于品牌还是漏在流量里。配了 `ASSET_TOKEN_KEY` 就用 AES-256-GCM 封成 `?d=<token>`：
 * 客户端只见我们自己的域名，且**改不动**（认证加密，篡改解不开）。
 * 不配密钥时退回明文 `src=`——本地自检和调试要能直接构造地址。
 */
const tokenKey = (process.env.ASSET_TOKEN_KEY || "").trim()
  ? createHash("sha256").update(process.env.ASSET_TOKEN_KEY.trim()).digest()
  : null;

function sealSource(url) {
  if (!tokenKey) return `src=${encodeURIComponent(url)}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey, iv);
  const body = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return `d=${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** 取回源站地址；解不开 / 不允许的形式一律返回 null（调用方回 400）。 */
function openSource(params) {
  const token = params.get("d");
  if (token) {
    if (!tokenKey) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", tokenKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
  // 配了密钥就只认加密形式（明文 src 会把上游域名漏在流量里）
  return tokenKey ? null : params.get("src");
}

if (!KEY) {
  console.error("缺少环境变量 TOONFLOW_MARKET_KEY（Toonflow 那边的 key，建议用没有余额的账号）");
  process.exit(1);
}

const cache = new Map();
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  list.push(now);
  hits.set(ip, list);
  return list.length > 120; // 每分钟 120 次，够用且不给人当免费网关刷
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,x-toonflow-workspace",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...corsHeaders(),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** 本服务的对外基址：优先 `PUBLIC_BASE_URL`，否则按请求的 Host 推断（反代场景读 X-Forwarded-*）。 */
function requestBase(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`)
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function fallbackFileName(link) {
  try {
    return decodeURIComponent(new URL(link).pathname.split("/").at(-1) || "") || "plugin.bin";
  } catch {
    return "plugin.bin";
  }
}

/**
 * 把列表里的 `link` 换成走本服务的下载代理。
 *
 * ⚠️ 传进来的必须是**未改写的原始体**（缓存里存的就是它）：下载地址要用「本次请求的 host」拼，
 *    缓存改写后的体会把上一个域名的地址发给下一个访客。
 */
function rewriteLinks(payload, base) {
  if (!PROXY_DOWNLOAD) return payload;
  const list = payload?.data?.list;
  if (!Array.isArray(list)) return payload;
  // ⚠️ 缓存里存的是共享引用：原地改写会把改写后的地址留在缓存里，
  //    下一个（不同 Host 的）请求就在污染体上二次改写 → src 嵌套 → 白名单 403。
  //    必须在副本上改，缓存里的原始体永远不动。
  payload = structuredClone(payload);
  for (const item of payload.data.list) {
    if (!item || typeof item.link !== "string" || !item.link) continue;
    // 防嵌套护栏：已是本服务的下载地址就绝不再包一层
    if (item.link.includes(ASSET_PREFIX)) {
      console.warn("[plugin-forwarder] 发现已改写的 link（上游异常或旧缓存），原样放行");
      continue;
    }
    // 顺带把文件名带进 path 末段：服务端安装时若没带 fileName，会从 URL 末段取文件名。
    // ⚠️ 必须保留上游 `/plugins/<type>/<identifier>/<version>/<file>` 的结构：
    //    服务端靠「版本号前一段」识别市场 identifier（中文名包的目录名就靠它），
    //    压扁成只剩文件名的话，identifier 提取不到 → 目录名退化成随机哈希 → 和已装的对不上。
    let suffix;
    try {
      suffix = /^\/plugins\/(.+)$/.exec(new URL(item.link).pathname)?.[1];
    } catch { /* 下面的 fallback 兜住 */ }
    if (!suffix) {
      const name = typeof item.fileName === "string" && item.fileName ? item.fileName : fallbackFileName(item.link);
      suffix = encodeURIComponent(name);
    }
    item.link = `${base}${ASSET_PREFIX}${suffix}?${sealSource(item.link)}`;
  }
  return payload;
}

/** 下载代理：白名单校验 → 取上游 → 流式回传。 */
async function proxyAsset(req, res, src) {
  let target;
  try {
    target = new URL(src);
  } catch {
    return json(res, 400, { code: 400, message: "下载地址无效" });
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    !ASSET_HOST.test(target.hostname) ||
    !ASSET_PATH.test(target.pathname)
  ) {
    // 拒绝也只在日志里说清楚（含被拒的地址），回给客户端的只是一个 403。
    console.warn(`[plugin-forwarder] 拒绝转发白名单外的地址：${src.slice(0, 160)}`);
    return json(res, 403, { code: 403, message: "Forbidden" });
  }

  let upstream;
  try {
    upstream = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    console.error("[plugin-forwarder] 取插件文件失败:", error instanceof Error ? error.message : error);
    return json(res, 502, { code: 502, message: "插件文件暂时无法下载" });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    console.warn(`[plugin-forwarder] 上游文件 HTTP ${upstream.status}：${src.slice(0, 160)}`);
    return json(res, 502, { code: 502, message: "插件文件暂时无法下载" });
  }

  const headers = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
    ...corsHeaders(),
  };
  const length = upstream.headers.get("content-length");
  if (length) headers["Content-Length"] = length;
  res.writeHead(200, headers);

  // 流式回传：插件可能几 MB，别整个读进内存。
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
    }
  } catch (error) {
    console.error("[plugin-forwarder] 回传中断:", error instanceof Error ? error.message : error);
  } finally {
    res.end();
    await reader.cancel().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "OPTIONS") return json(res, 204, {});

  const ip = req.socket.remoteAddress || "?";

  // ---- 下载代理（GET / HEAD）----
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { code: 405, message: "Method Not Allowed" });
    if (rateLimited(ip)) return json(res, 429, { code: 429, message: "请求过于频繁，请稍后再试" });
    if (req.method === "HEAD") return json(res, 200, {});
    const source = openSource(url.searchParams);
    if (!source) return json(res, 400, { code: 400, message: "下载地址无效" });
    return proxyAsset(req, res, source);
  }

  // ---- 列表 / 收藏（POST）----
  if (!ALLOWED.has(url.pathname)) return json(res, 404, { code: 404, message: "Not Found" });
  if (req.method !== "POST") return json(res, 405, { code: 405, message: "Method Not Allowed" });
  if (rateLimited(ip)) return json(res, 429, { code: 429, message: "请求过于频繁，请稍后再试" });

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, 400, { code: 400, message: error instanceof Error ? error.message : "请求体无效" });
  }

  const cacheKey = url.pathname + "|" + JSON.stringify(body);
  const base = requestBase(req);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return json(res, 200, rewriteLinks(cached.payload, base));
  }

  try {
    const upstream = await fetch(UPSTREAM + url.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    // ⚠️ 上游的报错**只进服务端日志**，绝不回给客户端：那是 Toonflow 的措辞（例如
    //    "用户信息错误"），露出去等于把来源递给用户；客户端只需要知道"暂时不可用"。
    //    另外这也让客户端的"需要填 key"分支永远不会误触发（key 在服务端，用户不该被问）。
    if (!upstream.ok) {
      console.warn(`[plugin-forwarder] 上游 HTTP ${upstream.status}：${text.slice(0, 200)}`);
      return json(res, 502, { code: 502, message: "插件服务暂时不可用" });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // 上游给了非 JSON（网关错误页之类）—— 同样只记日志。
      console.warn(`[plugin-forwarder] 上游返回的不是 JSON：${text.slice(0, 160)}`);
      return json(res, 502, { code: 502, message: "插件服务暂时不可用" });
    }
    // 缓存**改写前**的原始体（见 rewriteLinks 的说明）。
    if (CACHE_MS > 0) cache.set(cacheKey, { at: Date.now(), payload });
    return json(res, 200, rewriteLinks(payload, base));
  } catch (error) {
    console.error("[plugin-forwarder] 转发失败:", error instanceof Error ? error.message : error);
    return json(res, 502, { code: 502, message: "插件服务暂时不可用" });
  }
});

server.listen(PORT, () => {
  console.log(`[plugin-forwarder] 已启动：http://127.0.0.1:${PORT}（上游 ${UPSTREAM}，缓存 ${CACHE_MS / 1000}s）`);
  console.log(
    `[plugin-forwarder] 下载代理：${PROXY_DOWNLOAD ? "开（link 已改写走本服务）" : "关（link 直连上游域名）"}` +
      `${PUBLIC_BASE ? `，对外基址 ${PUBLIC_BASE}` : "，对外基址按请求 Host 推断"}`,
  );
  console.log("[plugin-forwarder] 客户端把 PLUGIN_MARKET_BASE_URL 指到本服务即可；生产环境请套一层 HTTPS。");
});
