const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    // ⚠️ 2026-10-14 起：**这把 key 不再需要了**，留空即可。
    //
    // 以前「带参考素材的生成」会直连 toapis，而 toapis 的生成接口只收公网 URL
    // （官方原话：「我们不再支持在生成接口中直接传入 base64 图片数据」）⇒ 本地素材
    // 必须先传到它那里换地址，这一步用它。
    //
    // 现在素材改成 **base64 直接内嵌**，由网关侧的 `toapi-forwarder` 转存到
    // **自建阿里云 OSS**（bucket `linke-ai`）再发给上游 —— 整条链路只认「Linke API Key」
    // 那一把，素材也不再经手 toapis 的账户。
    //
    // 字段保留只为不破坏老装机已有的配置（填了也无害）；新装可以留空。
    type: "input",
    field: "uploadApiKey" as const,
    title: "素材上传密钥（已不再需要，可留空）",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

const apiUrl = "https://api.linke.link/v1";
const version = "2.0.3";

/*
 * ────────────────────────────────────────────────────────────────────────────
 *  这份 models 清单是 Linke（api.linke.link，new-api 网关）的**权威分类表**。
 *
 *  为什么必须手写、不能靠自动获取分类：
 *    `GET /v1/models` 是**全量**返回，而且
 *      · 不返回 type —— 6 条里只有 `gpt-image-2` 带了一个 `supported_endpoint_types:
 *        ["image-generation","openai"]`，其余全是 `["openai"]`，分辨不出是文本还是视频；
 *      · **忽略 `?type=` 参数** —— 传 video / image / text / audio 四种值，
 *        返回的是同一批 6 个 id（实测）。
 *    所以「哪个 id 属于哪一类」在网关侧没有答案，只能由这张表提供。
 *    服务端刷新逻辑（refreshMediaProviderModels）会把它当作**已知分类**优先使用，
 *    未知 id 一律跳过、绝不猜测 —— 否则文本模型 deepseek-flash 会被塞进视频节点。
 *
 *  这张表只放**媒体**模型（image / video / audio）。
 *  大语言模型（deepseek-flash）属于文本侧，见 src/language/JinyuDream.ts。
 * ────────────────────────────────────────────────────────────────────────────
 */

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Linke 响应格式错误");
  return value as Record<string, unknown>;
}

/**
 * 链路：**一律走 Linke**（`api.linke.link`）。
 *
 * ## 2026-10-14 改（此前是「带素材直连 toapis」）
 *
 * 旧结论「Linke 丢弃参考素材字段」只在**客户端侧**看起来成立 —— 真正的原因是
 * new-api 的任务适配器用严格结构体 `relaycommon.TaskSubmitReq` 解析请求，只认
 * `prompt / model / mode / image / images / size / duration / seconds / input_reference / metadata`，
 * 其余键**静默丢弃**（`ratio`、`resolution`、`reference_images`、`image_with_roles` … 都是这样没的；
 * `image: [a, b]` 还会 400，因为结构体里它是 string）。
 *
 * 但 **`metadata` 是唯一能装任意 JSON 的字段**，而网关上的任务插件（new-api 的
 * `task_plugins` 表里那条 `sora`，当前 `1.0.10-models`）会把 `metadata` 里的键
 * **展开回顶层**再转发给 ToAPI ⇒ 客户端把业务参数整包放进 `metadata`（见 `linkeTaskBody`）
 * 就能原样透传。
 *
 * 素材同理：**直接内嵌 base64 data URL**，由网关侧的 `toapi-forwarder` 换成
 * **自建阿里云 OSS 的公网签名 URL** 再发给上游 —— 不再需要 toapis 的「素材上传密钥」，
 * 也不再有「带素材就绕过网关」这条旁路。
 *
 * 2026-10-14 已在服务器侧实测通过：`wan3.0-video` + 参考图经 Linke 提交成功，
 * forwarder 日志可见「1 张内嵌图换成公网 URL（OSS）」，Linke 后台把这笔记在了
 * `wan3.0-video` 名下（额度、resolution、seconds 都对）。
 *
 * 链路协议差异：路径的单复数（linke `video/generations` vs toapis `videos/generations`）
 * 与任务 ID 的字段名（linke `task_id` vs toapis `id`，`taskIdOf` 两个都认）—— 走网关时以 linke 为准。
 */
type Route = { base: string; path: string; key: string; label: string };

/** toapis 直连的基础地址 —— ⚠️ 2026-10-14 起**不再使用**（带素材也一律走 Linke），保留仅为可查。 */
function directBase() {
  return `${uploadBase}/v1`;
}

function routeKey(context: ProviderContext<Record<string, unknown>>, field: "apiKey" | "uploadApiKey") {
  const raw = context.config[field];
  return typeof raw === "string" ? raw.trim().replace(/^Bearer\s+/i, "").trim() : "";
}

/** 选链路 —— 现在**只有一条**：本网关（Linke）。见上方长注释。 */
function pickRoute(context: ProviderContext<Record<string, unknown>>): Route {
  const key = routeKey(context, "apiKey");
  if (!key) throw new Error("请填写 Linke API Key");
  // linke 是 new-api：图片也走 `video/generations` 这个**通用任务队列**（见 generateImage 的说明）。
  return { base: apiUrl, path: "video/generations", key, label: "Linke" };
}

/**
 * 把请求体整包塞进 `metadata`。
 *
 * new-api 的任务结构体只认那几个白名单字段，其余一律丢弃 —— 所以业务参数
 * （`ratio` / `resolution` / `reference_images` / `image_with_roles` / `audio` / `watermark` …）
 * 必须借 `metadata` 过境，由网关插件的 `requestValues()` 展开回顶层。
 *
 * `model` / `prompt` 留在顶层：插件 `buildSubmitRequest` 会校验 `prompt`；
 * `duration` 也留顶层（结构体认它，网关侧计费按它算秒数）。
 */
function linkeTaskBody(body: Record<string, unknown>): Record<string, unknown> {
  const { model, prompt, duration, metadata, ...rest } = body;
  // 调用方（`request.other`）可能自己带了 `metadata`，先与业务参数合并再整包下发，
  // 否则会套成 `metadata.metadata` 而被网关插件的展开逻辑丢掉。
  const merged = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}),
    ...rest,
  };
  return { model, prompt, ...(duration === undefined ? {} : { duration }), metadata: merged };
}

async function fetchJson(context: ProviderContext, route: Route, path: string, body?: unknown, signal = context.signal) {
  signal?.throwIfAborted();
  // 所有失败都带上「哪条链路 + 发了什么」—— 见 withTrace 的说明。
  const label = `${route.label} ${path}`;
  try {
    const response = await context.tool.fetch(`${route.base}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${route.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.clone().json().catch(() => null);
      // 两条链路的错误正文形态不同：linke 是 `{error:{message}}` / `{code,message}`，
      // toapis 是 `{error:{code,message}}` / `{code,message}`；统一交给提取器。
      throw new Error(context.tool.errorMessage?.(detail) || failReason(detail, "") || `${route.label} 请求失败（HTTP ${response.status}）`);
    }
    const payload = object(await response.json());
    // toapis 的成功响应**没有** `code` 字段，assertGatewayOk 对空 code 直接放行（两者兼容）。
    assertGatewayOk(payload);
    return payload;
  } catch (error) {
    throw new Error(withTrace(label, body, error));
  }
}

/**
 * 参考素材在请求体里属于哪一类字段（决定它能不能内嵌 base64）。
 */
type InlineField = "image" | "video" | "audio";

/** toapis 的素材上传（国内站）。三个端点：images / videos / audios（实测均存在）。 */
const uploadBase = "https://toapis.cn";
const uploadEndpoints: Record<InlineField, string> = { image: "images", video: "videos", audio: "audios" };
/** toapis 官方给的图片上限是 10 MB（视频/音频未标注，统一按同一上限卡，超了让用户先压缩）。 */
const uploadLimit = 10 * 1024 * 1024;

/**
 * 把本地素材上传到 toapis，换取**公网 URL**。
 *
 * ⚠️ 2026-10-14 起**不再被调用**（`referenceUrl` 改为直接内嵌 data URL，由网关侧的
 * `toapi-forwarder` 转存到自建 OSS）。实现保留在这里，是为了万一要切回「预上传」模式时不至于重写。
 */
async function uploadReference(
  context: ProviderContext<Record<string, unknown>>,
  input: MediaInput,
  kind: string,
  field: InlineField,
  signal?: AbortSignal,
) {
  const key = typeof context.config.uploadApiKey === "string" ? context.config.uploadApiKey.trim() : "";
  if (!key) {
    throw new Error(
      `${kind}用不了本地文件：本网关（Linke）**不转发**参考素材字段，所以带素材的生成会改走 toapis 直连，` +
      `而 toapis 的生成接口**只收公网地址**（官方原话：「我们不再支持在生成接口中直接传入 base64 图片数据」）。` +
      `画布上的素材是本地文件，必须先上传换一个公网地址 —— 这一步要用到**素材上传密钥（toapis）**。` +
      `请在「设置 → 媒体模型 → Linke → 编辑」里填上它（上传本身免费）；或把素材换成公网图片地址后再引用。`,
    );
  }
  // 走到这里只会是本地素材（公网 URL 在 referenceUrl 里已经直接返回）；
  // 这个守卫是为了让类型收窄成 binary | base64（否则 TS 不认 `input.data`）。
  if (input.type === "url") throw new Error(`参考${kind}需要 HTTP 或 HTTPS 地址`);
  const bytes = input.type === "binary" ? input.data : Buffer.from(input.data, "base64");
  if (!bytes.byteLength) throw new Error(`参考${kind}是空文件，无法上传`);
  if (bytes.byteLength > uploadLimit) {
    throw new Error(`${kind}过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，上限 ${uploadLimit / 1024 / 1024} MB），请先压缩再引用。`);
  }
  const mimeType = input.mimeType || "application/octet-stream";
  const extension = (mimeType.split("/")[1] || "bin").replace("jpeg", "jpg").split(";")[0]!;
  // ⚠️ 这里**手写 multipart**，不用 FormData/Blob —— 供应商适配器运行在一个受限的运行环境里，
  //    `FormData` 在那里面是 undefined（实测 `ReferenceError: FormData is not defined`），
  //    而 Buffer 一直可用（本文件其它地方也在用）。手写也更可控：边界、文件名、类型都自己定。
  const boundary = `----JinyuTVUpload${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="reference.${extension}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  // ⚠️ 必须用宿主注入的 `context.tool.fetch`，**不能**用全局 `fetch` ——
  //    供应商适配器跑在受限环境里，全局 `fetch` 是 undefined（实测 `ReferenceError: fetch is not defined`）；
  //    宿主那份还带请求计数/中断管理等。本文件其它请求（fetchJson）也是这么发的。
  const response = await context.tool.fetch(`${uploadBase}/v1/uploads/${uploadEndpoints[field]}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: { url?: string }; error?: { message?: string } }
    | null;
  const url = payload?.data?.url;
  if (!response.ok || !payload?.success || typeof url !== "string" || !url) {
    throw new Error(
      `参考${kind}上传失败（HTTP ${response.status}）：` +
      (payload?.message || payload?.error?.message || "上游未返回可用地址"),
    );
  }
  return url;
}

/**
 * 取参考素材的「可用地址」。
 *
 * · 本来就是公网 URL → 原样用；
 * · 本地文件 → **直接内嵌成 base64 data URL**（不再预上传）。
 *
 * 内嵌图会在网关侧由 `toapi-forwarder` 换成**自建 OSS 的公网签名 URL** 再发给上游，
 * 所以这里不需要（也不该）先调 toapis 的上传口 —— 少一次往返、少一把密钥，
 * 素材还留在我们自己家里。单张上限与 forwarder 保持一致（10 MB）。
 */
async function referenceUrl(
  _context: ProviderContext<Record<string, unknown>>,
  input: MediaInput,
  kind: string,
  _model: string,
  _field: InlineField,
  _signal?: AbortSignal,
): Promise<string> {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error(`参考${kind}需要 HTTP 或 HTTPS 地址`);
    return input.url;
  }
  const bytes = input.type === "binary" ? input.data : Buffer.from(input.data, "base64");
  if (!bytes.byteLength) throw new Error(`参考${kind}是空文件，无法引用`);
  if (bytes.byteLength > uploadLimit) {
    throw new Error(`${kind}过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，上限 ${uploadLimit / 1024 / 1024} MB），请先压缩再引用。`);
  }
  const mimeType = input.mimeType || "application/octet-stream";
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** 模型族。seedance 与 wan3.0 的字段名不一样（见下方 generateVideo 的注释）。 */
/**
 * 网关上的视频模型分**三家**，请求字段名互不相同（均据 toapis 官方文档）：
 *   · seedance-2 / seedance-2-mini → `aspect_ratio` + `image_with_roles` / `video_with_roles` /
 *     `audio_with_roles` + `generate_audio`
 *   · wan3.0-video                 → `ratio` + `reference_images` / `video_list` /
 *     `audio_with_roles` + `audio`（外加 `watermark`）
 *   · grok-video-1.5               → `aspect_ratio` + **单张 `image`**（只收公网 URL）：
 *     支持**文生视频与图生视频**；没有任何音频字段。
 * 早先这里只有 wan / seedance 两档，grok 被当成 seedance 发 `image_with_roles` →
 * 上游报"缺 image"。**加新视频模型时必须先确认它属于哪一族。**
 */
function modelFamily(model: string): "wan" | "grok" | "seedance" {
  const id = String(model).toLowerCase();
  if (id.startsWith("wan")) return "wan";
  if (id.startsWith("grok")) return "grok";
  return "seedance";
}

/**
 * 网关在 `code` 字段里表达错误（成功的轮询响应是 `{code:"success", data:{...}}`）。
 * 只看 HTTP 状态是不够的：同一个网关既有 `{error:{message}}`（非 2xx）也有
 * `{code:"invalid_request", message:"prompt is required"}` 这种形态。
 */
function assertGatewayOk(payload: Record<string, unknown>) {
  const code = typeof payload.code === "string" ? payload.code.trim().toLowerCase() : "";
  if (!code || code === "success" || code === "ok") return;
  throw new Error(
    failReason(payload, "") ||
    (typeof payload.message === "string" ? payload.message : "") ||
    `Linke 返回错误码：${code}`,
  );
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 3000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 终态判定用的状态词。new-api 各分支大小写不统一（SUCCESS / succeeded / COMPLETED…），统一转大写比较。 */
const doneStates = ["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE", "FINISHED"];
const failedStates = ["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED", "REJECTED"];

/**
 * 从任务响应里取出媒体地址。
 *
 * ⚠️ 为什么不是取固定字段：这个网关的返回结构**嵌套层数不固定**，
 *    `GET /v1/video/generations/{id}` 返回 `{code,data:{status,…,data:{…}}}`，
 *    而 `GET /v1/videos/{id}` 是 OpenAI-videos 风格的扁平对象。写死一条路径
 *    必然在另一条上取到 undefined。做法改成「先试常见路径，再全量扫描找媒体 URL」，
 *    这样换网关 / 网关升级都不会静默变成"没返回地址"。
 */
function pickMediaUrl(payload: unknown, mediaType: "image" | "video" | "audio", depth = 0): string | undefined {
  if (depth > 8 || payload == null) return undefined;
  if (typeof payload === "string") {
    const value = payload.trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (/^data:[^;]+;base64,/i.test(value)) return value;
    return undefined;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = pickMediaUrl(item, mediaType, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof payload !== "object") return undefined;
  const data = payload as Record<string, unknown>;

  // new-api 视频任务里视频地址的常见字段名；`result_url` 是这个网关在
  // 任务对象顶层直接给的快捷字段（实测 `GET /v1/video/generations/{id}` 里有），
  // `works` 是 new-api 自己的视频产物数组约定。
  for (const key of ["result_url", "resultUrl", "url", "video_url", "videoUrl", "image_url", "imageUrl", "audio_url", "outputUrl", "fileUrl", "downloadUrl"]) {
    const hit = pickMediaUrl(data[key], mediaType, depth + 1);
    if (hit) return hit;
  }
  const preference: Record<string, string[]> = {
    video: ["works", "output", "videos", "results", "data", "result", "content", "task"],
    image: ["data", "images", "output", "results", "result", "content", "task"],
    audio: ["data", "audios", "output", "results", "result", "content", "task"],
  };
  for (const key of preference[mediaType] ?? []) {
    const hit = pickMediaUrl(data[key], mediaType, depth + 1);
    if (hit) return hit;
  }
  // 兜底：任何键都扫一遍（顺序不影响结果，只是慢一点）。
  for (const value of Object.values(data)) {
    const hit = pickMediaUrl(value, mediaType, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function failReason(payload: unknown, fallback: string, depth = 0): string {
  if (depth > 6 || payload == null) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload !== "object") return "";
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = failReason(item, fallback, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  const data = payload as Record<string, unknown>;
  for (const key of ["fail_reason", "failReason", "failure_reason", "error", "errors", "message", "msg", "detail", "details"]) {
    const hit = failReason(data[key], fallback, depth + 1);
    if (hit && hit !== fallback) return hit;
  }
  return "";
}

/**
 * 上游把内层错误塞成一个 **JSON 字符串**时，把它拆开。
 *
 * linke / toapis 这一族网关对**异步任务失败**的返回是
 * `{code:"fail_to_fetch_task", message:"{\"code\":\"InvalidParameter.ImageFormat\", …}"}`
 * —— `message` 本身是一段 JSON 文本。直接透传的话，用户在界面上只能看到一串
 * 带转义的 JSON，既读不懂也不知道怎么改。
 */
function unwrapUpstreamMessage(text: string) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const nested = parsed.message ?? parsed.msg;
    if (typeof nested === "string" && nested.trim()) {
      const code = typeof parsed.code === "string" ? parsed.code : "";
      return code ? `${nested.trim()}（${code}）` : nested.trim();
    }
    const error = parsed.error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const inner = (error as Record<string, unknown>).message;
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
    if (typeof parsed.code === "string") return parsed.code;
  } catch {
    // 不是 JSON 就原样返回，绝不因为"翻译"把原文吞掉。
  }
  return trimmed;
}

/**
 * 上游报错 → 人话（**永远保留原文**）。
 *
 * 这几条都是实测过的、用户按字面完全无法处理的错误：
 *   · `fail_to_fetch_task` 内层 `may contain real person` —— **真人门禁**。
 *     2026-09-20 在参考实现（灵雀 `ai_gateway.py`）里记着原始报文原文，
 *     本文件按同一份指纹识别。它不是参数错、重试无用，只能换参考图。
 *   · `base64 image is not allowed` —— 上游不收内嵌图，参考素材必须先有公网地址。
 *   · `no matching pricing rule` —— 网关没有这个"清晰度 / 时长"组合的计价规则，
 *     同样不是网络问题、重试无用。
 */
const upstreamHints: readonly [RegExp, string][] = [
  [
    /real[\s_-]?person|contains?\s+(a\s+)?(real\s+)?(human|person)|真人|肖像|活体/i,
    "上游判定**参考图里含真人**（内容安全策略），本次生成被拒。换一张不含真人形象的参考图即可（插画 / 场景 / 产品图都可以）",
  ],
  [
    /base64\s+image\s+is\s+not\s+allowed|内嵌图/i,
    "上游不接受内嵌（base64）图片：参考素材必须是公网可访问的地址",
  ],
  [
    /pricing rule|no matching pricing/i,
    "这个清晰度 / 时长组合在网关里**没有对应的计价规则**（不是网络问题，重试无用）—— 换一个清晰度或时长再试",
  ],
];

function humanizeUpstream(message: string) {
  const readable = unwrapUpstreamMessage(message);
  for (const [pattern, hint] of upstreamHints) {
    if (pattern.test(readable)) return `${hint}。\n上游原文：${readable}`;
  }
  return readable;
}

/**
 * 把「这次发的到底长什么样」编成一行诊断，附在错误里。
 *
 * 服务端日志只打印 `error.message`，而生成失败以前在日志里就一句话
 * （`… → Error: 输入参数无效`）—— 无从判断是参数、是链路、还是素材。
 * 这里把链路 + 关键字段 + 参考素材的**数量与形态**（url / base64 / 带 role）一并带上，
 * 且**不含任何密钥**。
 */
function describeRequestBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "无请求体";
  const data = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["model", "duration", "resolution", "ratio", "aspect_ratio", "size", "n", "generate_audio", "audio", "watermark", "video_operation"]) {
    const value = data[key];
    if (value !== undefined) parts.push(`${key}=${Array.isArray(value) ? value.length : String(value)}`);
  }
  for (const key of ["image_urls", "reference_images", "image_with_roles", "video_with_roles", "video_list", "audio_with_roles"]) {
    const value = data[key];
    if (!Array.isArray(value) || !value.length) continue;
    const kinds = value.map(item => {
      if (typeof item === "string") return item.startsWith("data:") ? "base64" : "url";
      const url = (item as { url?: unknown })?.url;
      const role = (item as { role?: unknown })?.role;
      const kind = typeof url === "string" && url.startsWith("data:") ? "base64" : "url";
      return typeof role === "string" ? `${kind}:${role}` : kind;
    });
    parts.push(`${key}×${value.length}[${[...new Set(kinds)].join(",")}]`);
  }
  return parts.join(" ") || "无关键字段";
}

/** 错误 → 带上链路与请求体诊断（已带过的不重复叠加）。 */
function withTrace(label: string, body: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const human = humanizeUpstream(message);
  if (human.includes("\n（诊断：")) return human;
  return `${human}\n（诊断：${label}｜${describeRequestBody(body)}）`;
}

function taskIdOf(payload: Record<string, unknown>): string {
  for (const key of ["task_id", "id", "taskId", "request_id", "requestId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return taskIdOf(data as Record<string, unknown>);
  return "";
}

/**
 * 提交任务 → 轮询到终态。
 *
 * 网关（new-api）的协议是异步的：POST 拿 task_id，GET 查状态，
 * **和原版 Toonflow 私有后端那套 `video/generateVideo` + `video/getVideoStatus`
 * 完全不同**（那两条路径在这个域名上都是 404），所以这里整体重写过。
 */
async function generateTask(context: ProviderContext, route: Route, mediaType: "image" | "video" | "audio", body: unknown, signal: AbortSignal) {
  const submitted = await fetchJson(context, route, route.path, body, signal);
  // 有的网关对图片是**同步**返回（OpenAI `/v1/images/generations` 就是），
  // 提交响应里直接带地址，这时不该再去轮询一个不存在的任务。
  const inline = pickMediaUrl(submitted, mediaType);
  if (inline) return inline;
  const taskId = taskIdOf(submitted);
  if (!taskId) throw new Error(`${route.label} 未返回任务 ID`);
  const name = { image: "图片", video: "视频", audio: "音频" }[mediaType];
  // 轮询要有**兜底时限**：网关偶尔会让任务永远停在中间态（返回 task_not_exist 或一直
  // 不前进），没有这道闸门时节点会一直卡在「生成中」直到 signal 超时（视频是 30 分钟）。
  const deadline = Date.now() + 28 * 60_000;
  while (true) {
    if (Date.now() > deadline) throw new Error(`${route.label} ${name}生成超时（超过 28 分钟仍未完成）`);
    const result = await fetchJson(context, route, `${route.path}/${encodeURIComponent(taskId)}`, undefined, signal);
    // 两种协议的状态位置不同：linke 在 `{code:"success",data:{status,...}}`，
    // toapis 在顶层 `{status:"completed", result:{data:[{url}]}}` —— 两个都取。
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
    const status = String(data.status ?? result.status ?? "").toUpperCase();
    if (doneStates.includes(status)) {
      const url = pickMediaUrl(result, mediaType);
      if (!url) throw new Error(`${route.label} 任务已完成，但没有返回${name}地址`);
      return url;
    }
    if (failedStates.includes(status)) {
      // 任务级失败同样要翻译 + 留痕：linke / toapis 把内层原因塞在 `code` + `message`
      // 里（例如 `fail_to_fetch_task` + "may contain real person" 就是真人门禁），
      // 不翻的话用户只看到一串英文/JSON。
      throw new Error(withTrace(
        `${route.label} ${route.path}`,
        body,
        context.tool.errorMessage?.(result) || failReason(result, "") || `${route.label} ${name}生成失败`,
      ));
    }
    await wait(signal);
  }
}

/**
 * gpt-image-2 的**权威能力表**（逐项对照上游 toapis 官方文档的「尺寸对照表」）。
 *
 * ⚠️ 这个接口的 `size` 值是**宽高比**（`"1:1"` / `"16:9"`），**不是像素尺寸**。
 *    之前把节点上的「档位 + 比例」换算成 `"1024x1024"` 发出去，上游先把它当成非法比例，
 *    再推出一个不存在的 `resolution:1024p` 去匹配渠道 → 一律
 *    `no available channel for model_name: gpt-image-2, params: map[n:1 resolution:1024p size:1024x1024]`，
 *    图片根本发不出去（当时误判成「这个网关不能用图片」，其实是参数形态错了）。
 *    正确写法：`size: "<比例>"` + `resolution: "1k" | "2k" | "4k"`。
 *    实测**比例会被严格采纳**（4:3 → 1024×768、16:9 → 1376×768）；
 *    但**像素尺寸随上游渠道浮动**，未必逐档等于文档表格（1:1 曾回 1254×1254、2K 的 16:9 回了 1376×768），
 *    所以别对外承诺"选 2K 就一定是 2048×1152"。
 *
 * 档位与比例的关系：**1K / 2K 支持全部 13 种比例；4K 只支持 8 种**
 * （不含 1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 5:4 / 4:5）。
 *
 * ⚠️ 下面这两组常量与 `models:` 里那份字面量是**有意重复**的，改一处必须同步改另一处：
 *    `models` 数组必须是**纯 JSON 字面量** —— 服务端读取供应商文件时会按 JSON 解析并
 *    重写这段，一旦写成 `[...imageRatios]` 这类引用标识符的写法，**整份适配器都会解析失败**
 *    （日志报 `Linke 媒体模型更新失败：models 仅支持 JSON 字面量`），后果是这家供应商的
 *    模型列表**整个消失**（实测踩过：图片模型直接从节点下拉里没了）。
 */
const imageRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"] as const;
const imageRatios4k = ["4:3", "3:4", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"] as const;
/** GPT Image 2.5 Flare 的比例集：官方 10 种，**没有** 2:1 / 1:2 / 9:21，且三档不分叉。 */
const flareImageRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"] as const;
/** 提示词上限：官方对 GPT image 系列给的是 32,000 字符。 */
const promptLimit = 32000;
/** 参考图上限：官方 16 张（公网 URL 或本地图内嵌均可，见 referenceUrl 的说明）。 */
const referenceLimit = 16;

export default {
  id: "JinyuDream" as const,
  label: "Linke",
  version,
  apiUrl,
  // ⚠️ 不带 `?type=`：网关忽略这个参数（四种 type 返回同一批 id），
  //    带了反而会让人误以为「服务端已经按类型过滤好了」。
  //    分类由本文件的 models 清单负责。
  modelsUrl: "https://api.linke.link/v1/models",
  protocol: "openai-completions",
  // 说明统一成「正文 + 🔗 通过此 [注册链接](…) 注册即可开用。」这一种格式，
  // 文本侧（language/JinyuDream.ts）用同一句，两边只有一处来源的差别。
  // 注意链接色由 messageMarkdown 的 --primary（= --ui-brand-foreground）决定，别写死颜色。
  readme: "## JinyuTV 官方中转平台\n\n提供文本、图像、视频等多模态模型服务。\n\n**图片**：GPT Image 2（比例 13 种）、GPT Image 2.5 Flare（比例 10 种）；档位均为 1K / 2K / 4K，提示词 ≤ 32,000 字，参考图 ≤ 16 张。\n\n**视频**：Seedance 2.5（4–30 秒，480p–1080p）、Seedance 2.0（4–15 秒，480p / 720p / 1080p / 4k）、Seedance 2.0 Mini（4–15 秒，480p / 720p）、Wan 3.0（2–30 秒，480p–1080p）、Grok Video 1.5（1–15 秒，480p / 720p）。\n\n**关于参考素材**：画布上的本地图片、视频、音频都能直接用 —— 软件会先把它上传换成一个公网地址，再交给生成接口（上游只收公网地址）。这一步需要在「编辑」里填写**素材上传密钥（toapis）**，上传本身免费。\n\n用参考素材时，**提示词里要点名**（「图片1」「视频1」「音频1」，与素材顺序一一对应），上游对没有点名的素材通常会忽略。\n\n🔗 通过此 [注册链接](https://api.linke.link/register) 注册即可开用。",
  rules,
  models: [
    {
      id: "seedance-2",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      // 官方（toapis docs / model-guide）：aspect_ratio 支持 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9，
      // 另有 `adaptive`（由上游按输入素材自动挑比例）。
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      durationResolutionMap: [
        {
          // `-1` = 自动时长；官方对 seedance-2 与 seedance-2-fast 开放（mini 没有）。
          duration: [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          // 只有标准版有 1080p 与 4k。
          resolution: ["480p", "720p", "1080p", "4k"],
        },
      ],
    },
    {
      id: "seedance-2-mini",
      label: "Seedance 2.0 Mini",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      durationResolutionMap: [
        {
          // ⚠️ mini **只有 480p / 720p**（没有 1080p、没有 4k），时长也只有 4–15、**不含自动时长**。
          //    之前照标准版抄了一份带 1080p 的，用户选了就会在上游失败。
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["480p", "720p"],
        },
      ],
    },
    {
      id: "seedance-2-5",
      label: "Seedance 2.5",
      type: "video",
      // 官方（toapis docs /videos/seedance-2-5）：文生视频、首尾帧、视频编辑、视频延长、多模态参考。
      // 参考素材上限比 2.0 大得多：图片 30 张 / 视频 10 段 / 音频 10 段（总计 ≤ 50）。
      mode: ["text", "startFrameOptional", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      // 官方：21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / adaptive。
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      durationResolutionMap: [
        {
          // ⚠️ **4–30 秒**（比 seedance-2.0 的 4–15 长一倍），`-1` 为自动时长。
          //    这是全站第二个能到 30 秒的模型（另一个是 wan3.0）。
          duration: [
            -1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
          ],
          // 官方只有 480p / 720p / 1080p（**没有 4k**，那是 2.0 标准版才有的）。
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "grok-video-1.5",
      label: "Grok Video 1.5",
      type: "video",
      // 官方文档写的是「支持**文本到视频**、图生视频」，示例里也有纯文生视频那一条
      // （`{model, prompt, duration, resolution, aspect_ratio}`）。
      // ⚠️ 早先这里写的是「只支持图生视频、不支持文生视频」并把 mode 限成 `["singleImage"]`，
      //    那是**把文档读反了** —— 后果是纯文本用它会直接报「没有适合这些参考素材的生成模式」，
      //    白白禁掉了一个本来就有的能力。
      // 参考图字段是 `image`（主图，单张）+ `reference_images`（人物/服装/场景一致性，
      // 与 `image` 合计 ≤ 8 张），**两者都只收公网 URL**（官方原话：「不再支持在
      // `reference_images` 中直接传入 base64 图片数据」）—— 本地图会在本地被拦下并提示。
      // 多图参考（`reference_images`）尚未实测，本轮先不声明，避免用户走到没验证的路径上。
      mode: ["text", "singleImage"],
      // 该模型没有任何音频参数 → 固定 false（不发 generate_audio / audio）。
      audio: false,
      // 官方：1:1 / 16:9 / 9:16 / 3:2 / 2:3。中英文文档对 4:3、3:4、21:9 说法不一致，
      // 这里取两版英文文档一致的那 5 个，宁可少给也不让用户选到上游不收的比例。
      videoRatios: ["1:1", "16:9", "9:16", "3:2", "2:3"],
      durationResolutionMap: [
        // 官方：1–15 秒（默认 8），分辨率只有 480p / 720p。
        { duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] },
      ],
    },
    {
      id: "wan3.0-video",
      label: "Wan 3.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      // 有 `audio` 布尔参数（开/关同价）→ 用 "optional"，界面上才会出现声音开关。
      audio: "optional",
      // 官方：adaptive / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 —— **没有 21:9**（那是 seedance 才有的）。
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"],
      durationResolutionMap: [
        {
          // 官方 2–30 秒（**这里确实是 30**，与 seedance 的 4–15 不同）；
          // `-1` 为智能时长。注意：有视频输入时「输入 + 输出」总长不能超过 30 秒。
          duration: [
            -1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
          ],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      type: "image",
      // 支持多张参考图（官方上限 16 张）。参考图可以是公网 URL，也可以是本地图 ——
      // 本地图由 referenceUrl 内嵌成 data URL 发出（linke 侧认 base64，见那边的说明）。
      mode: ["text", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      // ↓↓↓ 必须是纯 JSON 字面量（原因见文件上方 imageRatios 的注释），不要改成引用常量。
      imageRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"],
      // 4K 收窄了比例集合，必须按档位给，否则用户会在 4K 下选到上游会拒的比例。
      imageRatioMap: {
        "1K": ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"],
        "2K": ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"],
        "4K": ["4:3", "3:4", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"],
      },
    },
    {
      id: "gpt-image-2.5-flare",
      label: "GPT Image 2.5 Flare",
      type: "image",
      // 与 GPT Image 2 同一套用法：文生图 + 多参考图（参考图同样支持公网 URL 与本地图内嵌）。
      mode: ["text", "multiReference"],
      // 官方 model-guide：档位 1K / 2K / 4K（每张约 $0.0225 / $0.03 / $0.0375）。
      imageSizes: ["1K", "2K", "4K"],
      // ⚠️ 与 GPT Image 2 不同：**没有 2:1 / 1:2 / 9:21**，只有这 10 种比例预设。
      imageRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
      // 文档没有逐档列出「哪些比例在 4K 不可用」（gpt-image-2 是会砍掉一部分的），
      // 所以三档给同一份，不擅自替用户砍选项。
      imageRatioMap: {
        "1K": ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
        "2K": ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
        "4K": ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"],
      },
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const images = await Promise.all((request.images ?? []).map(input => referenceUrl(this, input, "图片", request.model, "image", signal)));
    // 两个图片模型的比例能力不同（GPT Image 2 有 13 种；2.5 Flare 只有 10 种，没有 2:1/1:2/9:21），
    // 所以校验表要**按模型**取 —— 否则会替另一个模型放行它其实不收的比例。
    const flare = request.model === "gpt-image-2.5-flare";
    const label = flare ? "GPT Image 2.5 Flare" : "GPT Image 2";
    // 能力上限先在本地拦一道，给出人能看懂的话；不然要等上游回一个含混的 400。
    if (images.length > referenceLimit) throw new Error(`${label} 最多支持 ${referenceLimit} 张参考图（当前 ${images.length} 张）`);
    if (request.prompt.length > promptLimit) throw new Error(`提示词过长：${label} 最多 ${promptLimit} 个字符（当前 ${request.prompt.length} 个）`);
    const tier = (request.size ?? "1K").toUpperCase();
    // 只有 gpt-image-2 的 4K 收窄了比例集合；2.5 Flare 三档是同一份。
    const allowed: readonly string[] = flare ? flareImageRatios
      : tier === "4K" ? imageRatios4k : imageRatios;
    const ratio = request.ratio ?? "1:1";
    if (!allowed.includes(ratio)) {
      throw new Error(`${label} 的 ${tier} 档不支持 ${ratio} 比例（支持：${allowed.join("、")}）`);
    }
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      // ⚠️ size = **宽高比**，resolution = **档位**，两者都是 toapis 的语义，别改成像素尺寸。
      //    （曾经发 `size:"1024x1024"` 导致上游一律"无可用渠道"，见 imageRatios 上方说明。）
      size: ratio,
      resolution: tier.toLowerCase(),
      n: request.n ?? 1,
      // ⚠️ 参考图字段名是 **`image_urls`**（据 gpt-image-2 官方文档：「`image_urls` —— 参考图 URL
      //    数组，用于图生图；最多 16 张，须为公网可访问的稳定 URL」）。
      //    早先这里发的是 `reference_images` —— 那是 **wan3.0 / grok 的字段名**，GPT Image 系列
      //    不认，上游会**静默忽略**（不报错、照样扣费），表现就是「挂了参考图却完全没用上」。
      ...(images.length ? { image_urls: images } : {}),
    };
    // ⚠️ 图片也必须走**任务端点** `video/generations`，不能用 `images/generations`。
    //    原因（2026-10-12 实测）：
    //      ① `/v1/images/generations` 是**只提交、不查询**的半截接口 —— 提交后返回
    //         `{id:"tsk_img_…", object:"generation.task"}`，但
    //         `GET /v1/images/generations/{id}` 与 `GET /v1/tasks/{id}` 全是 404，
    //         拿不到任何结果；
    //      ② 而 `/v1/video/generations` 是这个网关的**通用异步任务接口**：
    //         它同样受理 gpt-image-2（模型校验通过），提交拿 task_id、
    //         `GET /v1/video/generations/{id}` 轮询到终态，
    //         终态带 `result_url`（实测出图成功：
    //         `https://files.toapis.cn/images/tsk_img_…/xxx.png`，整单约 ¥0.8）。
    //    端点名字叫 video，但它是任务队列，图片模型一样跑。
    // 有参考图 → 直连 toapis（linke 会把 `image_urls` 整个丢掉，见文件上方 Route 的说明）。
    const route = pickRoute(this);
    const url = await generateTask(this, route, "image", linkeTaskBody(body), signal);
    return [{ mediaType: "image", type: "url", url }];
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const family = modelFamily(request.model);
    // 三类素材各自解析：认得 base64 的直接内嵌，不认得的（wan/grok 的全部分，seedance 的视频）
    // 会**先上传到 toapis 换成公网 URL** 再发出去 —— 详见 referenceUrl / uploadReference。
    const [images, videos, audios] = await Promise.all([
      Promise.all((request.images ?? []).map(input => referenceUrl(this, input, "图片", request.model, "image", signal))),
      Promise.all((request.videos ?? []).map(input => referenceUrl(this, input, "视频", request.model, "video", signal))),
      Promise.all((request.audios ?? []).map(input => referenceUrl(this, input, "音频", request.model, "audio", signal))),
    ]);
    // 首尾帧只在**帧模式**下才取。之前无条件用 images[0]/images[1] 兜底，
    // 结果「混合参考」模式会同时发出首尾帧 + 参考素材 —— 同一批图既当首帧又当参考，
    // 上游只会报参数冲突。
    const isFrameMode = request.mode === "startEndRequired" || request.mode === "endFrameOptional" || request.mode === "startFrameOptional";
    const firstFrame = request.firstFrame ? await referenceUrl(this, request.firstFrame, "首帧", request.model, "image", signal) : isFrameMode ? images[0] : undefined;
    const lastFrame = request.lastFrame ? await referenceUrl(this, request.lastFrame, "尾帧", request.model, "image", signal) : isFrameMode ? images[1] : undefined;

    // ── 首尾帧 vs 参考图：官方文档的**两条硬约束**（2026-10-12 逐模型核对 toapis 文档）。
    //
    //   ① role 只有三个合法值 —— `first_frame` / `last_frame` / `reference_image`，
    //      且首帧、尾帧**各最多一张**；
    //   ② **首尾帧模式与参考素材模式互斥** —— 同一请求不能既给首尾帧、又给参考图/参考视频
    //      （wan 侧原文："Wan 3.0 不能在同一请求中混用首尾帧与参考素材"）。
    //
    // ⚠️ 之前这里把首帧/尾帧**混进参考图数组**、并统一用 `reference_image` 发出去
    //    （seedance 走 `image_with_roles`、wan 更糟：塞进 `reference_images`）。后果是把
    //    "首帧"降级成了"普通参考图"——位置不受控；wan 侧更是直接撞上"混用"的硬报错。
    //    参考实现（灵雀 `video_route._norm_role` / `build_media_roles`）执行的是同一套规则。
    const frames: { url: string; role: "first_frame" | "last_frame" }[] = [];
    if (firstFrame) frames.push({ url: firstFrame, role: "first_frame" });
    if (lastFrame) frames.push({ url: lastFrame, role: "last_frame" });
    // 帧模式下节点不会再给参考图（`images` 是空的）；真同时给了就明确报错 ——
    // 静默丢素材正是"设了参考却没生效"这类问题的共同形态。
    if (frames.length && images.length) {
      throw new Error(
        `首尾帧与参考图**不能同时使用**（上游硬约束）：这次既有首帧/尾帧，又有 ${images.length} 张参考图。` +
        "请二选一 —— 只留首尾帧，或把生成模式换成「参考图」模式。",
      );
    }
    // 只给尾帧不给首帧：seedance 允许（节点的「首帧可选」模式单图时就是这样），
    // 但 wan3.0 官方写明"使用 last_frame 时必须同时提供 first_frame"。
    if (lastFrame && !firstFrame && family === "wan") {
      throw new Error(
        "Wan 3.0 的**尾帧不能单独使用**（官方要求必须同时提供首帧）。请再补一张图片作首帧，" +
        "或把生成模式换成「参考图」模式。",
      );
    }
    // 上游硬约束：参考视频 / 参考音频**不能单独提交**，至少要有 1 张参考图
    //（官方原文「at least one reference image is always required」）。
    // 与其发出去让上游报错（既费时、又可能计费），不如在本地拦住并说清怎么改。
    if (!images.length && !frames.length && (videos.length || audios.length)) {
      throw new Error(
        `参考${videos.length ? "视频" : "音频"}不能单独提交：上游要求至少配 **1 张参考图**。` +
        "请再挂一张图片，或改用纯提示词生成。",
      );
    }

    // ── 字段名按**模型族**分开，两边不一样（对自 toapis 官方接入脚本）：
    //    seedance：aspect_ratio + image_with_roles / video_with_roles / audio_with_roles + generate_audio
    //    wan3.0  ：ratio        + image_with_roles(首尾帧) / reference_images(参考图) / video_list / audio_with_roles + audio + watermark
    // 之前两种都发 `ratio`，seedance 侧等于没传画面比例（被上游忽略，出片比例不对）。
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      duration: request.duration,
      resolution: request.resolution,
    };
    // 首尾帧任务按上游要求用 `adaptive`（比例由首帧决定）—— 官方在 seedance 侧写的是
    // "要求"、wan 侧写的是"建议"，两边口径一致，所以统一这么发。
    // 用户选的比例与首帧不一致时，这里就等于放弃用户的选择而遵从上游 —— 这是文档要求的，
    // 不是我们擅自改（用户选的比例本来也只在文生视频/参考图模式下有意义）。
    const ratio = frames.length ? "adaptive" : request.ratio;
    if (ratio) {
      if (family === "wan") body.ratio = ratio;
      else body.aspect_ratio = ratio;   // seedance 与 grok 都用 aspect_ratio
    }
    if (typeof request.generateAudio === "boolean" && family !== "grok") {
      // grok 没有任何音频字段，传了反而会被当成未知参数。
      if (family === "wan") {
        body.audio = request.generateAudio;
        body.watermark = false;
      } else {
        body.generate_audio = request.generateAudio;
      }
    }
    if (family === "grok") {
      // grok 的参考图字段叫 `image`（单张，不是数组、没有 role）。
      // **纯文本也是允许的** —— 官方明确「支持文本到视频、图生视频」，
      // 所以没挂图时不发 `image` 即可，别在这里拦（早先这里硬编码报「只支持图生视频」，是读反了文档）。
      // grok 的模式里本来就没有帧模式（只有 text / singleImage），帧只可能来自 API 调用方。
      const first = firstFrame ?? lastFrame ?? images[0];
      if (first) body.image = first;
    } else if (family === "wan") {
      // wan3.0 的两条通道**不能混用**：首尾帧走 `image_with_roles`（带 role），
      // 参考图走 `reference_images`（纯字符串数组）。
      if (frames.length) body.image_with_roles = frames;
      else if (images.length) body.reference_images = images;
      if (videos.length) body.video_list = videos.map(video_url => ({ video_url }));
      if (audios.length) body.audio_with_roles = audios.map(url => ({ url, role: "reference_audio" }));
    } else {
      // seedance：首尾帧与参考图都走 `image_with_roles`，区别只在 role。
      const roleItems = frames.length ? frames : images.map(url => ({ url, role: "reference_image" }));
      if (roleItems.length) body.image_with_roles = roleItems;
      if (videos.length) body.video_with_roles = videos.map(url => ({ url, role: "reference_video" }));
      if (audios.length) body.audio_with_roles = audios.map(url => ({ url, role: "reference_audio" }));
    }
    // 素材（图 / 视频 / 音频 / 首尾帧）照常放进 body，由 `linkeTaskBody` 收进 metadata 过网关；
    // 其中的本地素材已被 referenceUrl 内嵌成 data URL，网关侧会换成自建 OSS 的公网地址。
    const route = pickRoute(this);
    const url = await generateTask(this, route, "video", linkeTaskBody({ ...body, ...(request.other ?? {}) }), signal);
    return [{ mediaType: "video", type: "url", url, mimeType: "video/mp4" }];
  },
} satisfies ProviderDefinition<typeof rules>;
