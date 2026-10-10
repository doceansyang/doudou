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
const version = "2.0.1";

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
  if (!response.ok) throw new Error(`Linke 请求失败（HTTP ${response.status}）`);
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

function audioReference(input: MediaInput, mediaType: "image" | "audio") {
  if (input.mimeType && !input.mimeType.startsWith(`${mediaType}/`)) throw new Error(`参考媒体类型须为 ${mediaType}`);
  if (input.type === "url") return { [`${mediaType}_url`]: mediaUrl(input) };
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(mediaUrl(input));
  if (!match || !match[1].startsWith(`${mediaType}/`)) throw new Error(`参考媒体类型须为 ${mediaType}`);
  const data = match[2].replace(/\s/g, "");
  if (!data || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考媒体的 base64 内容无效");
  return { [`${mediaType}_data`]: data };
}

function mediaAsset(value: unknown, mediaType: MediaAsset["mediaType"], mimeType?: string): MediaAsset[] {
  if (typeof value !== "string" || !value.trim()) throw new Error("Linke 未返回生成结果");
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) return [{ mediaType, type: "url", url, ...(mimeType ? { mimeType } : {}) }];
  const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (!data || !data[1].startsWith(`${mediaType}/`)) throw new Error("Linke 返回的媒体地址无效");
  return [{ mediaType, type: "base64", mimeType: data[1], data: data[2] }];
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

async function generateTask(context: ProviderContext, mediaType: "image" | "video" | "audio", body: unknown, mimeType?: string) {
  // ACT: 单次生成最多等待 30 分钟；供应商开放任务恢复能力后再单独保存任务 ID。
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const path = mediaType === "audio" ? "tts" : mediaType;
  const name = { image: "Image", video: "Video", audio: "Audio" }[mediaType];
  const task = await fetchJson(context, `${path}/${mediaType === "audio" ? "create" : `generate${name}`}`, body, signal);
  if (typeof task.data !== "string" || !task.data.trim()) throw new Error("Linke 未返回任务 ID");
  while (true) {
    const result = await fetchJson(context, `${path}/get${name}Status`, { taskICode: task.data }, signal);
    const data = result.data == null ? {} : object(result.data);
    const status = String(result.status ?? data.status ?? "").toLowerCase();
    if (status === "success" || status === "completed") return mediaAsset(data.data, mediaType, mimeType);
    if (["failed", "failure", "error", "rejected"].includes(status)) {
      throw new Error(context.tool.errorMessage?.(result) || (typeof data.failReason === "string" ? data.failReason : `${{ image: "图片", video: "视频", audio: "音频" }[mediaType]}生成失败`));
    }
    await wait(signal);
  }
}

export default {
  id: "JinyuDream" as const,
  label: "Linke",
  version,
  apiUrl,
  modelsUrl: "https://api.linke.link/v1/models?type=video",
  protocol: "openai-completions",
  readme: "## JinyuTV 官方中转平台\n\n提供文本、图像、视频、音频等多模态模型服务。\n\n[前往中转平台](https://api.linke.link/)",
  rules,
  models: [
    { id: "seed-audio-1.0", label: "Seed Audio 1.0", type: "audio" },
    {
      id: "Seedance 2.5",
      label: "Seedance-2.5",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "Seedance 2.0",
      label: "Seedance-2.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "Seedance 2.0 fast",
      label: "Seedance 2.0 fast",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "Seedance 2.0 mini",
      label: "Seedance 2.0 mini",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "wan-3.0",
      label: "Wan3.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional",
      durationResolutionMap: [
        {
          duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
          resolution: ["480p", "720p", "1080p"],
        },
      ],
    },
    {
      id: "MiniMax-H3",
      label: "MiniMax-H3",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "audioReference:3"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
      audio: true,
    },
    {
      id: "doubao-seedream-5.0-Pro",
      label: "Doubao Seedream 5.0 Pro",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "1.5K", "2K"],
      imageRatios: ["16:9", "9:16"],
    },
    {
      id: "doubao-seedream-5.0-Lite",
      label: "Doubao Seedream 5.0 Lite",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "3K", "4K"],
      imageRatios: ["16:9", "9:16"],
    },
    {
      id: "全能图片G-2.5",
      label: "全能图片G-2.5",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "21:9"],
    },
    {
      id: "全能图片G-2.0",
      label: "全能图片G-2.0",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "21:9"],
    },
  ] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const text = (request.text ?? request.prompt ?? "").trim();
    if (!text) throw new Error("请输入音频生成文本");
    const format = request.format ?? "mp3";
    const mimeTypes: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", pcm: "audio/pcm", ogg_opus: "audio/ogg" };
    if (!Object.hasOwn(mimeTypes, format)) throw new Error("Linke 音频格式仅支持 wav、mp3、pcm、ogg_opus");
    const sampleRate = request.sampleRate ?? 24000;
    if (![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw new Error("Linke 音频采样率须为 8000、16000、22050、24000、32000、44100 或 48000 Hz");
    const speed = request.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error("Linke 音频语速须在 0.5 到 2 倍之间");
    const volume = request.volume ?? 0;
    const volumeLimit = 20 * Math.log10(2);
    if (!Number.isFinite(volume) || volume < -volumeLimit || volume > volumeLimit) throw new Error("Linke 音量增益须在约 -6.02 到 6.02 dB 之间");
    const pitch = request.pitch ?? 0;
    if (!Number.isFinite(pitch) || pitch < -12 || pitch > 12) throw new Error("Linke 音调偏移须在 -12 到 12 之间");
    const references = [
      ...(request.audios ?? []).map(input => audioReference(input, "audio")),
      ...(request.images ?? []).map(input => audioReference(input, "image")),
    ];
    return generateTask(this, "audio", {
      model: request.model,
      text,
      format,
      ...(references.length ? { references } : {}),
      sampleRate,
      speechRate: Math.round((speed - 1) * 100),
      loudnessRate: Math.round((10 ** (volume / 20) - 1) * 100),
      pitchRate: pitch,
    }, mimeTypes[format]);
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const model = request.model.toLowerCase();
    const images = (request.images ?? []).map(mediaUrl);
    const size = (request.size ?? "2K").toUpperCase();
    const ratio = request.ratio ?? "16:9";
    // if (!["1K", "2K", "4K"].includes(size)) throw new Error("Linke 图片尺寸仅支持 1K、2K、4K");

    let metadata: Record<string, unknown>;
    let resolvedSize: string;
    if (model.includes("doubao") || model.includes("seedream")) {
      resolvedSize = size.toLowerCase();
      if (!resolvedSize) throw new Error("Linke Seedream 适配仅支持 16:9、9:16");
      metadata = { response_format: "url", aspectRatio: ratio, sequential_image_generation: "disabled", stream: false, watermark: false };
    } else if (model.includes("gpt") || model.includes("全能图片")) {
      resolvedSize = size.toLowerCase();
      metadata = { aspectRatio: ratio };
    } else {
      resolvedSize = size.toLowerCase();
      metadata = { aspectRatio: ratio };
    }
    return generateTask(this, "image", {
      model: request.model,
      prompt: request.prompt,
      size: resolvedSize,
      ...(images.length ? { images } : {}),
      metadata,
    });
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const model = request.model.toLowerCase();
    const images = (request.images ?? []).map(mediaUrl);
    const videos = (request.videos ?? []).map(mediaUrl);
    const audios = (request.audios ?? []).map(mediaUrl);
    const frames = [
      ...(request.firstFrame ? [{ url: mediaUrl(request.firstFrame), role: "first_frame" }] : []),
      ...(request.lastFrame ? [{ url: mediaUrl(request.lastFrame), role: "last_frame" }] : []),
    ];
    const mode = request.mode ?? (frames.length ? "endFrameOptional" : videos.length || audios.length ? [] : images.length ? "singleImage" : "text");
    const isFrames = mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional";
    const frameImages = frames.length ? frames : images.map((url, index) => ({ url, role: index === 0 ? "first_frame" : "last_frame" }));
    const imageRefs = isFrames ? frameImages.map((item) => item.url) : images;
    const ratio = request.ratio ?? "16:9";
    let metadata: Record<string, unknown>;

    if (model.includes("kling")) {
      metadata = {
        aspect_ratio: ratio,
        sound: request.generateAudio ? "on" : "off",
        video_list: videos.map((url) => ({ video_url: url })),
        image_list: [],
      };

      if (model.includes("omni") || model.includes("o1")) {
        metadata.image_list = isFrames
          ? frameImages.map(({ url, role }) => ({ image_url: url, type: role === "first_frame" ? "first_frame" : "end_frame" }))
          : images.map((url) => ({ image_url: url }));
      } else {
        if (imageRefs[0]) metadata.image = imageRefs[0];
        if (isFrames && imageRefs[1]) metadata.image_tail = imageRefs[1];
      }
    } else if (model.includes("grok")) {
      metadata = { aspectRatio: ratio };
    } else {
      const references: Record<string, unknown>[] = [];
      if (Array.isArray(mode)) {
        for (const [type, urls] of [
          ["image", images],
          ["video", videos],
          ["audio", audios],
        ] as const) {
          references.push(...urls.map((url) => ({ role: `reference_${type}`, type: `${type}_url`, [`${type}_url`]: { url } })));
        }
      } else if (isFrames) {
        references.push(...frameImages.map(({ url, role }) => ({ role, type: "image_url", image_url: { url } })));
      } else if (mode === "singleImage") {
        references.push(...images.map((url) => ({ role: "reference_image", type: "image_url", image_url: { url } })));
      }
      metadata = {
        ...(typeof request.generateAudio === "boolean" ? { generate_audio: request.generateAudio } : {}),
        ratio,
        references,
        resolution: request.resolution,
      };
    }
    return generateTask(this, "video", {
      model: request.model,
      prompt: request.prompt,
      duration: request.duration,
      resolution: request.resolution,
      metadata,
    });
  },
} satisfies ProviderDefinition<typeof rules>;
