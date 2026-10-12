const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

const apiUrl = "https://api.linke.link/v1";
const version = "2.0.2";

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

async function fetchJson(context: ProviderContext, path: string, body?: unknown, signal = context.signal) {
  const apiKey =
    typeof context.config.apiKey === "string"
      ? context.config.apiKey
          .trim()
          .replace(/^Bearer\s+/i, "")
          .trim()
      : "";
  if (!apiKey) throw new Error("请填写 Linke API Key");
  signal?.throwIfAborted();
  const response = await context.tool.fetch(`${apiUrl}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(context.tool.errorMessage?.(await response.clone().json().catch(() => null)) || `Linke 请求失败（HTTP ${response.status}）`);
  return object(await response.json());
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考媒体需要 HTTP 或 HTTPS 地址");
    return input.url;
  }
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
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
async function generateTask(context: ProviderContext, mediaType: "image" | "video" | "audio", path: string, body: unknown, signal: AbortSignal) {
  const submitted = await fetchJson(context, path, body, signal);
  // 有的网关对图片是**同步**返回（OpenAI `/v1/images/generations` 就是），
  // 提交响应里直接带地址，这时不该再去轮询一个不存在的任务。
  const inline = pickMediaUrl(submitted, mediaType);
  if (inline) return inline;
  const taskId = taskIdOf(submitted);
  if (!taskId) throw new Error("Linke 未返回任务 ID");
  const name = { image: "图片", video: "视频", audio: "音频" }[mediaType];
  while (true) {
    const result = await fetchJson(context, `${path}/${encodeURIComponent(taskId)}`, undefined, signal);
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
    const status = String(data.status ?? result.status ?? "").toUpperCase();
    if (doneStates.includes(status)) {
      const url = pickMediaUrl(result, mediaType);
      if (!url) throw new Error(`Linke 任务已完成，但没有返回${name}地址`);
      return url;
    }
    if (failedStates.includes(status)) {
      throw new Error(context.tool.errorMessage?.(result) || failReason(result, "") || `Linke ${name}生成失败`);
    }
    await wait(signal);
  }
}

/**
 * gpt-image-2 的 size 只接受 WxH（每边为 16 的倍数、长短边比 ≤ 3:1、
 * 总像素 655,360–8,294,400），不接受 "1K"/"2K" 这类档位名。
 * 这里把节点上的「档位 + 比例」换算成合法像素尺寸。
 */
const imageSizes: Record<string, Record<string, string>> = {
  "1K": { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" },
  "2K": { "1:1": "2048x2048", "3:2": "2400x1600", "2:3": "1600x2400" },
};

function resolveImageSize(size: string | undefined, ratio: string | undefined) {
  const tier = imageSizes[(size ?? "1K").toUpperCase()] ?? imageSizes["1K"]!;
  return tier[ratio ?? "1:1"] ?? tier["1:1"]!;
}

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
  readme: "## JinyuTV 官方中转平台\n\n提供文本、图像、视频等多模态模型服务。\n\n[前往中转平台](https://api.linke.link/)",
  rules,
  models: [
    {
      id: "seedance-2",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "seedance-2-mini",
      label: "Seedance 2.0 Mini",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "grok-video-1.5",
      label: "Grok Video 1.5",
      type: "video",
      // Grok Imagine 1.5：文生视频 + 单图（首帧）。不做多参考 —— 官方参考图走的是
      // 另一个模型档位，未确认这个 id 在网关上是否放开，先不声明，避免用户选到会失败的模式。
      mode: ["text", "singleImage"],
      audio: true,
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
      durationResolutionMap: [
        { duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] },
      ],
    },
    {
      id: "wan3.0-video",
      label: "Wan 3.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: true,
      videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      durationResolutionMap: [
        {
          duration: [
            2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
          ],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      type: "image",
      mode: ["text", "singleImage"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const images = (request.images ?? []).map(mediaUrl);
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      size: resolveImageSize(request.size, request.ratio),
      n: request.n ?? 1,
      // gpt-image-2 不接受 input_fidelity（它恒定高保真），照 OpenAI 规范省略。
      ...(request.quality ? { quality: request.quality } : {}),
      ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
    };
    const url = await generateTask(this, "image", "images/generations", body, signal);
    return [{ mediaType: "image", type: "url", url }];
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const images = (request.images ?? []).map(mediaUrl);
    const videos = (request.videos ?? []).map(mediaUrl);
    const audios = (request.audios ?? []).map(mediaUrl);
    // 首尾帧只在**帧模式**下才取。之前无条件用 images[0]/images[1] 兜底，
    // 结果「混合参考」模式会同时发出 first_frame_url + last_frame_url + references ——
    // 同一批图既当首尾帧又当参考素材，上游只会报参数冲突（干跑实测就是这个形状）。
    const isFrameMode = request.mode === "startEndRequired" || request.mode === "endFrameOptional" || request.mode === "startFrameOptional";
    const firstFrame = request.firstFrame ? mediaUrl(request.firstFrame) : isFrameMode ? images[0] : undefined;
    const lastFrame = request.lastFrame ? mediaUrl(request.lastFrame) : isFrameMode ? images[1] : undefined;

    // 首尾帧 / 参考素材统一放进 metadata，具体字段名各上游不一致，
    // 这里同时给出两套常见写法（first_frame_url/last_frame_url 与 image_with_roles），
    // 由上游取它认识的那个 —— 比只发一套然后报"参数缺失"要好。
    const references: Record<string, unknown>[] = [];
    if (Array.isArray(request.mode)) {
      for (const [kind, urls] of [["image", images], ["video", videos], ["audio", audios]] as const) {
        references.push(...urls.map(url => ({ role: `reference_${kind}`, type: `${kind}_url`, [`${kind}_url`]: { url } })));
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      duration: request.duration,
      resolution: request.resolution,
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(typeof request.generateAudio === "boolean" ? { generate_audio: request.generateAudio } : {}),
      ...(firstFrame ? { first_frame_url: firstFrame } : {}),
      ...(lastFrame ? { last_frame_url: lastFrame } : {}),
      ...(references.length ? { references } : {}),
      ...(request.other ?? {}),
    };
    const url = await generateTask(this, "video", "video/generations", body, signal);
    return [{ mediaType: "video", type: "url", url, mimeType: "video/mp4" }];
  },
} satisfies ProviderDefinition<typeof rules>;
