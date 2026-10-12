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
 * 路由形态（节点里有两套模板，都要支持）：
 *   ① ModelScope 形状（节点默认源）：
 *        GET /api/modelSource/<model>/repo?Revision=master&FilePath=onnx/model_quantized.onnx
 *   ② HuggingFace 形状（节点的「自定义模型源地址」走这个）：
 *        GET /api/modelSource/<model>/resolve/<revision>/<file>
 *   两种都归一成上游 ModelScope 的 `/api/v1/models/<model>/repo?Revision=&FilePath=`。
 *
 * 上游为什么固定 ModelScope：国内直连可用；hf-mirror 的 ONNX 会 302 到
 * `cas-bridge.xethub.hf.co`，那个域名国内常连不上（节点自己的说明里也承认这点）。
 *
 * 安全：只放行 `GET/HEAD`，只允许 `namespace/name` 形状的模型 id 与保守字符集的文件路径，
 * 禁止 `..` 与协议/查询串注入 —— 不做出网跳板（防 SSRF）。
 */

const router = Router();

/** 上游：ModelScope 开放模型仓库接口（国内直连）。 */
const UPSTREAM = "https://modelscope.cn/api/v1/models";

/** 模型 id：`namespace/name`。 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 文件路径：`目录/文件名`，字符集保守。 */
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** rRevision：允许 `main`、`master`、`v1.0` 这类。 */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 只透传这些上游响应头，避免把上游的 CORS/Cookie 头带回来干扰页面。 */
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

/** 上游总超时：Base 模型可达 370MB，给足时间。 */
const UPSTREAM_TIMEOUT_MS = 600_000;

function fail(res: Response, message: string, code: number) {
  res.status(code).json(error(message, null, code));
}

/** 把两种 URL 形状归一成 { model, revision, file }，拿不准就返回空串由调用方拒绝。 */
function parseTarget(subPath: string, query: unknown) {
  const params = (query ?? {}) as Record<string, unknown>;
  let segments = subPath.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  // 节点里 ModelScope 的 host 自带 `/api/v1/models`，统一吃掉再判断形状。
  const lower = segments.map((part) => part.toLowerCase());
  if (lower[0] === "api" && lower[1] === "v1" && lower[2] === "models") segments = segments.slice(3);
  else if (lower[0] === "api" && lower[1] === "models") segments = segments.slice(2);

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

router.use(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    fail(res, "只支持 GET/HEAD", 405);
    return;
  }

  const raw = (req.originalUrl || req.url).split("?")[0];
  const subPath = raw.slice(req.baseUrl.length) || "/";
  const { model, revision, file } = parseTarget(subPath, req.query);

  if (!MODEL_ID.test(model)) {
    fail(res, "模型标识不合法（应为 namespace/name）", 400);
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

  const target = `${UPSTREAM}/${model}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encodeURIComponent(file)}`;

  // Range 透传：推理库对大文件可能按段取。
  const headers: Record<string, string> = { accept: "*/*" };
  if (typeof req.headers.range === "string") headers.range = req.headers.range;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // 页面侧中断（取消运行、换源重试）时不要继续拉上游。
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(target, { headers, redirect: "follow", signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      console.error(`[modelSource] 上游 ${upstream.status}：${model}/${file}`);
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
    console.error(`[modelSource] 下载失败 ${model}/${file}：${message}`);
    fail(res, `模型源请求失败：${message}`, 502);
  }
});

export default router;
