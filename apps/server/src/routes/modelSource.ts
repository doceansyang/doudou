import { Router } from "express";
import type { Response } from "express";
import { error } from "@/lib/responseFormat";

/**
 * 同源「模型源」代理 —— 给那些**在页面里直接 fetch 模型权重**的画布节点兜底。
 *
 * 为什么必须有它（2026-10-13 实测）：
 *   「视频深度动捕」(depthCaptureNode) 在 WebView2 页面里 fetch 模型权重，
 *   而模型源（ModelScope / hf-mirror）**不返回 `Access-Control-Allow-Origin`**，
 *   浏览器一律判 `TypeError: Failed to fetch`。实测证据（同一台机器）：
 *     · 终端 curl 直连 + 走系统代理 → ModelScope / hf-mirror 全 200；
 *     · 页面（从 http://localhost:3000 发起）→ **0ms** 就 `Failed to fetch`，
 *       控制台明写 `blocked by CORS policy: No 'Access-Control-Allow-Origin' header`。
 *   所以不是网络问题、也不是代理问题 —— 是 CORS。
 *   把下载改走本机服务端（同源、无 CORS）再回传给页面，节点即可正常下载。
 *
 * 路由形态（**宽松解析**，节点不同版本 / 不同来源写法不一样，都要吃得下）：
 *   ① ModelScope 形状（节点默认源）：
 *        /api/modelSource/<model>/repo?Revision=master&FilePath=onnx/model_quantized.onnx
 *   ② HuggingFace 形状（节点的「自定义模型源地址」走这个）：
 *        /api/modelSource/<model>/resolve/<revision>/<file>
 *   ③ 前缀可有可无：`api/v1/models`、`v1/models`、`api/models`、`models`
 *        —— 老版节点拼出来的 host 少一段 `/api`，实测收到过 `/v1/models/...`，
 *           旧实现在这里直接 400（用户报「还是用不了」就是这个）。
 *   几种都归一成上游 ModelScope 的 `/api/v1/models/<model>/repo?Revision=&FilePath=`。
 *
 * 上游为什么固定 ModelScope：国内直连可用；hf-mirror 的 ONNX 会 302 到
 * `cas-bridge.xethub.hf.co`，那个域名国内常连不上（节点自己的说明里也承认这点）。
 *
 * 安全：只放行 `GET/HEAD`，只允许保守字符集的模型 id 与文件路径，
 * 禁止 `..` 与协议/查询串注入 —— 不做出网跳板（防 SSRF）。
 */

const router = Router();

/** 上游：ModelScope 开放模型仓库接口（国内直连）。 */
const UPSTREAM = "https://modelscope.cn/api/v1/models";

/**
 * 模型 id 允许 **1~4 段**（每段保守字符集）。
 *
 * 为什么放宽到多段：同一个模型在不同来源里写法不同 ——
 * ModelScope 是 `namespace/name`（`onnx-community/depth-anything-v2-small`），
 * 而有的来源会拆成 `onnx-community/depth-anything-v2/small`（把名字里的连字符当目录）。
 * 多段形状由 `modelCandidates()` 归一；这里只做「字符集 + 段数」的形式校验。
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
/** 文件路径：`目录/文件名`，字符集保守。 */
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** rRevision：允许 `main`、`master`、`v1.0` 这类。 */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 只透传这些上游响应头，避免把上游的 CORS/Cookie 头带回来干扰页面。 */
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

/** 上游总超时：Base 模型可达 370MB，给足时间。 */
const UPSTREAM_TIMEOUT_MS = 600_000;

/**
 * 已确认可用的模型 id 解析结果（`原始写法 → 上游认的写法`）。
 *
 * 只放正常解析出来的；进程内缓存，省掉每次下载的探测请求。
 */
const resolvedModels = new Map<string, string>();

function fail(res: Response, message: string, code: number) {
  res.status(code).json(error(message, null, code));
}

/** 把各种 URL 形状归一成 { model, revision, file }，拿不准就返回空串由调用方拒绝。 */
function parseTarget(subPath: string, query: unknown) {
  const params = (query ?? {}) as Record<string, unknown>;
  let segments = subPath.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  // 节点里的 host 可能自带 `api/v1/models`、`v1/models`（老版少一段 `api`）、或干脆没有前缀，统一吃掉。
  const lower = segments.map((part) => part.toLowerCase());
  if (lower[0] === "api" && lower[1] === "v1" && lower[2] === "models") segments = segments.slice(3);
  else if (lower[0] === "v1" && lower[1] === "models") segments = segments.slice(2);
  else if (lower[0] === "api" && lower[1] === "models") segments = segments.slice(2);
  else if (lower[0] === "models") segments = segments.slice(1);

  const fileParam = typeof params.FilePath === "string" ? params.FilePath : "";
  /** ⚠️ ModelScope 默认分支叫 `master`，HuggingFace 那套叫 `main`。HF 形状会把 `main` 放在
   *  路径里，直接透给 ModelScope 会 404（实测踩过）。两条分支取到 revision 后统一归一。 */
  const normalize = (value: string) => (value === "main" ? "master" : value);
  const queryRevision = typeof params.Revision === "string" && params.Revision ? params.Revision : "master";

  const hasRepo = lower.at(-1) === "repo";

  // ① ModelScope 形状：<model>/repo?Revision=&FilePath=（`repo` 是接口的一部分，不属于模型 id）
  if (fileParam) return { model: (hasRepo ? segments.slice(0, -1) : segments).join("/"), revision: normalize(queryRevision), file: fileParam };
  if (hasRepo) return { model: segments.slice(0, -1).join("/"), revision: normalize(queryRevision), file: "" };

  // ② HF 形状：<model>/resolve/<revision>/<file...>
  const at = lower.indexOf("resolve");
  if (at > 0 && segments.length >= at + 3) {
    return { model: segments.slice(0, at).join("/"), revision: normalize(segments[at + 1]), file: segments.slice(at + 2).join("/") };
  }

  return { model: "", revision: normalize(queryRevision), file: "" };
}

/**
 * 同一个模型可能被写成不同形状，按「最可能对」的顺序给候选，逐个轻量探测取第一个可用的。
 *
 * 实测（2026-10-13）：`onnx-community/depth-anything-v2/small` 上游 404，
 * `onnx-community/depth-anything-v2-small` 上游 200 —— 后者是 ModelScope 里的真实仓库名。
 */
function modelCandidates(model: string): string[] {
  const parts = model.split("/").filter(Boolean);
  const out = [model];
  if (parts.length >= 3) {
    // owner/a/b → owner/a-b（把被拆开的尾段用 `-` 并回名字里，实测命中）
    out.push([parts[0], parts.slice(1).join("-")].join("/"));
    // owner/a/b → owner/a（有的是「仓库名 + 版本目录」）
    out.push(parts.slice(0, parts.length - 1).join("/"));
    // owner/a/b → owner/b
    out.push([parts[0], parts[parts.length - 1]].join("/"));
  }
  return [...new Set(out)].filter((item) => MODEL_ID.test(item));
}

/** 拼上游地址。 */
function upstreamUrl(model: string, revision: string, file: string): string {
  return `${UPSTREAM}/${model}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encodeURIComponent(file)}`;
}

router.use(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    fail(res, "只支持 GET/HEAD", 405);
    return;
  }

  const raw = (req.originalUrl || req.url).split("?")[0];
  const subPath = raw.slice(req.baseUrl.length) || "/";
  const { model, revision, file } = parseTarget(subPath, req.query);

  if (!MODEL_ID.test(model)) {
    fail(res, `模型标识不合法（应为 namespace/name）：${model || "（空）"}`, 400);
    return;
  }
  if (!file || !FILE_PATH.test(file) || file.includes("..")) {
    fail(res, "文件路径不合法", 400);
    return;
  }
  if (!REVISION.test(revision)) {
    fail(res, "revision 不合法", 400);
    return;
  }

  const candidates = modelCandidates(model);
  let chosen = resolvedModels.get(model) ?? "";

  // 唯一候选（最常见的 `namespace/name`）：直接下，不额外探测，零开勤开销。
  if (!chosen && candidates.length === 1) chosen = candidates[0];

  // 多形状候选：先用 `Range: bytes=0-0` 挨个轻量探测（只拿 1 字节，不下载正文），取第一个可用的。
  if (!chosen) {
    for (const candidate of candidates) {
      const probe = await fetch(upstreamUrl(candidate, revision, file), {
        headers: { accept: "*/*", range: "bytes=0-0" },
        redirect: "follow",
      }).catch(() => null);
      await probe?.body?.cancel().catch(() => undefined);
      if (!probe) continue;
      if (probe.ok) {
        chosen = candidate;
        resolvedModels.set(model, candidate);
        if (candidate !== model) console.log(`[modelSource] 模型 id 归一：${model} → ${candidate}`);
        break;
      }
      if (probe.status !== 404) {
        // 非 404（403/5xx/超时）说明这个形状是存在的，只是这次取不到 —— 用它，让下面报真实错误。
        chosen = candidate;
        break;
      }
    }
  }

  if (!chosen) {
    console.error(`[modelSource] 上游都找不到：${model}/${file}（试过 ${candidates.join("、")}）`);
    fail(res, `模型源里没有这个模型（${model}），请检查模型名或换成「HuggingFace 镜像」`, 404);
    return;
  }

  // Range 透传：推理库对大文件可能按段取。
  const headers: Record<string, string> = { accept: "*/*" };
  if (typeof req.headers.range === "string") headers.range = req.headers.range;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // 页面侧中断（取消运行、换源重试）时不要继续拉上游。
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(upstreamUrl(chosen, revision, file), { headers, redirect: "follow", signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      console.error(`[modelSource] 上游 ${upstream.status}：${chosen}/${file}`);
      fail(res, `模型源暂时不可用（上游 ${upstream.status}），请稍后重试`, 502);
      return;
    }

    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }
    res.set("Cache-Control", "public, max-age=86400");
    res.status(upstream.status);

    if (req.method === "HEAD") {
      clearTimeout(timer);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 背压：大模型不能一次性堆进内存。
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
    }
    clearTimeout(timer);
    res.end();
  } catch (cause) {
    clearTimeout(timer);
    if (res.headersSent || res.destroyed) {
      res.end();
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[modelSource] 下载失败 ${chosen}/${file}：${message}`);
    fail(res, `模型源请求失败：${message}`, 502);
  }
});

export default router;
