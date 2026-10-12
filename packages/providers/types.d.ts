/// <reference types="bun" />

type ModelType = "text" | "image" | "video" | "audio";

type ImageMode = "text" | "singleImage" | "multiReference";
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`${"video" | "image" | "audio"}Reference:${number}`)[];

interface ProviderModel {
  id: string;
  label: string;
  type: ModelType;
  think?: boolean;
  mode?: (ImageMode | VideoMode)[];
  associationSkills?: string;
  audio?: "optional" | boolean;
  imageSizes?: string[];
  imageRatios?: string[];
  /**
   * 图片模型「各分辨率档位各支持哪些宽高比」。
   *
   * 为什么要按档位分：同一模型的高档位常常**收窄比例集合** —— gpt-image-2 的 1K / 2K
   * 支持全部 13 种比例，4K 只支持 8 种（不含 1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 5:4 / 4:5）。
   * 只给一份扁平 `imageRatios`，用户就会在 4K 下选到上游会拒的比例。
   * 节点按当前档位过滤比例按钮；缺省时回退 `imageRatios`。
   */
  imageRatioMap?: Record<string, string[]>;
  /**
   * 视频模型支持的画面宽高比，如 `["16:9", "9:16"]`。
   *
   * 为什么必须由模型声明：比例是**按模型**变的 —— Seedance 2.0 有 21:9，
   * Wan 3.0 有 adaptive，Grok 只有 1:1/16:9/9:16 一类的常规档；
   * 节点里写死一份公共列表，用户就会选到模型其实不支持的比例。
   * 缺省时由节点回退到一组保守默认值。
   */
  videoRatios?: string[];
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
  voices?: { title: string; voice: string }[];
}

interface ProviderFormRule {
  field: string;
  value: unknown;
}

type ProviderConfig<TRules extends readonly ProviderFormRule[]> = {
  [TRule in TRules[number] as TRule["field"]]: TRule["value"];
};

interface ProviderContext<TConfig = Record<string, unknown>> {
  config: TConfig;
  signal?: AbortSignal;
  /** 宿主直接注入工具，供应商无需 import；FFmpeg 为按需安装的插件能力。 */
  tool: ProviderTools;
}

interface MediaRequest {
  model: string;
  /** 仅放供应商专属参数；公共字段的映射与支持范围由供应商校验。 */
  other?: Record<string, unknown>;
}

/** 抽象层的媒体来源；供应商负责转换为平台需要的 URL、文件或字节。 */
type MediaInput =
  | { type: "url"; url: string; mimeType?: string }
  | { type: "base64"; data: string; mimeType: string }
  | { type: "binary"; data: Uint8Array; mimeType: string };

type MediaAsset = MediaInput & { mediaType: "image" | "video" | "audio" };

interface AudioConvertOptions {
  format: "wav" | "mp3";
  /** 裁剪起点，单位秒，含边界；缺省为 0。 */
  startSeconds?: number;
  /** 裁剪终点，单位秒，不含边界；缺省为音频末尾。 */
  endSeconds?: number;
  /** 目标采样率；缺省保持原采样率。 */
  sampleRate?: number;
  /** mp3 比特率，单位 kbps；缺省 128，仅 format 为 mp3 时生效。 */
  bitrateKbps?: number;
}

/** 缺少可用 FFmpeg 时抛出；由宿主前端询问下载安装，供应商应继续向上抛出。 */
interface FfmpegRequiredError extends Error {
  name: "FfmpegRequiredError";
  code: "FFMPEG_REQUIRED";
  status: 424;
}

interface ProviderTools {
  fetch: typeof globalThis.fetch;
  /** 提取供应商错误正文中的可读原因，并隐藏配置中的密钥和 URL 查询参数。 */
  errorMessage(value: unknown): string;
  hash: typeof Bun.hash;
  image: typeof Bun.Image;
  /**
   * 音频裁剪转码；仅接受 WAV 格式的内存字节并返回处理后的内存字节，不支持文件路径、URL 或其他压缩格式输入。
   */
  audio: {
    convert(input: Uint8Array, options: AudioConvertOptions): Promise<{ data: Uint8Array; mimeType: string }>;
  };
  /**
   * 获取绑定当前工作区的原生 @renmu/fluent-ffmpeg 工厂，沿用链式调用、事件、流和 ffprobe 回调。
   * 仅显式文件路径经过工作区边界检查；原始参数、滤镜及清单中的间接 I/O 不是沙箱。
   * 宿主始终注入此入口，调用时检查 FFmpeg/FFprobe；没有工作目录的调试上下文不能使用。
   * 缺失时抛出 FfmpegRequiredError，并通知在线前端询问下载；不会后台自动安装。
   * 安装后由用户重新发起操作，供应商不要捕获此错误后自动重试完整生成请求。
   * 输出覆盖行为沿用原生库；调用方负责文件命名、处理 end/error 及通过 command.kill 取消运行。
   * @throws {FfmpegRequiredError} 未安装或当前设置未找到可用的 FFmpeg。
   * @example const ffmpeg = await this.tool.ffmpeg(); const command = ffmpeg("assets/input.mp4").videoCodec("libx264");
   */
  ffmpeg(): Promise<import("@toonflow/ffmpeg/types").FfmpegFactory>;
}

interface ImageRequest extends MediaRequest {
  prompt: string;
  /** 参考图。 */
  images?: MediaInput[];
  mask?: MediaInput;
  /** 生成数量。 */
  n?: number;
  /** 画面宽高比，如 16:9。 */
  ratio?: string;
  /** 输出尺寸，如 1K、2K、4K 或 1024x1024；具体格式由供应商转换。 */
  size?: string;
  /** 画质档位，如 low、medium、high，由供应商映射。 */
  quality?: string;
  /** 输出编码格式，如 png、jpeg、webp。 */
  outputFormat?: string;
}

interface VideoRequest extends MediaRequest {
  prompt: string;
  /** 当前生成模式；参考模式数组声明各类参考媒体数量上限。 */
  mode?: VideoMode;
  /** 参考图；首尾帧通过 firstFrame、lastFrame 单独传入。 */
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  /** 输出时长，单位秒；支持范围由供应商按模型校验。 */
  duration?: number;
  /** 画面宽高比，如 16:9。 */
  ratio?: string;
  /** 分辨率档位，如 720p、1080p。 */
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
}

/** 基础音频生成参数；text、prompt 至少提供一项，非空校验与模型能力检查由供应商负责。 */
type AudioRequest = MediaRequest & {
  /** 待朗读的文本，用于文本转语音。 */
  text?: string;
  /** 音频创作或语音风格提示词，可与待朗读的 text 分开传入。 */
  prompt?: string;
  /** 参考音频，可附带该段音频的准确转写文本；上传或复刻流程由供应商处理。 */
  audios?: (MediaInput & { text?: string })[];
  /** 音频创作参考图；数量以及能否与参考音频同传，由供应商按模型校验。 */
  images?: MediaInput[];
  /** 系统或已复刻的音色标识，由供应商映射到平台的音色参数。 */
  voice?: string;
  /** 语速倍率，1 为正常语速；供应商负责转换平台的语速刻度。 */
  speed?: number;
  /** 音量增益，单位 dB，0 为原始音量；供应商负责转换平台的音量刻度。 */
  volume?: number;
  /** 抽象层以半音表示音调偏移，0 为原音调；供应商负责映射平台刻度并校验支持范围。 */
  pitch?: number;
  /** 情绪，如 happy、sad、angry；由供应商映射并校验模型及音色是否支持。 */
  emotion?: string;
  /** 合成语言或方言，如 zh-CN、en、yue；由供应商映射，缺省沿用模型默认行为。 */
  language?: string;
  /** 是否规范化数字等文本的读法；支持语种与处理规则由供应商按模型校验。 */
  normalizeText?: boolean;
  /** 输出编码格式，如 mp3、wav、pcm、flac、opus；由供应商映射平台的格式名称。 */
  format?: string;
  /** 输出采样率，单位 Hz。 */
  sampleRate?: number;
  /** 输出编码码率，单位 kbps；仅适用于支持配置码率的格式，由供应商转换平台单位。 */
  bitrateKbps?: number;
} & ({ text: string } | { prompt: string });

/**
 * 三种生成函数统一返回最终媒体数组，不能返回任务 ID 或原始平台响应。
 * ACT: 本层只约定完整结果；供应商内部处理轮询/流读取，失败时抛出异常。
 */
type GenerateMedia<TRequest, TConfig = Record<string, unknown>> = (
  this: ProviderContext<TConfig>,
  request: TRequest,
) => Promise<MediaAsset[]>;

interface ProviderUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  notice: string;
}

interface ProviderDefinition<TRules extends readonly ProviderFormRule[] = readonly ProviderFormRule[]> {
  id: string;
  label: string;
  /** 适配文件版本，独立于模型版本；新增供应商应填写，缺省仅兼容旧文件。 */
  version?: string;
  apiUrl?: string;
  /**
   * 媒体模型列表 GET 地址，使用配置的 apiKey 作为 Bearer 凭据，返回 { data: 模型数组 }。
   * 模型须含 id，type 可由 URL 的 type 参数或同名已有模型补全。
   * 提供此字段后可手动获取；仅 Linke 在有 key 的程序启动时自动更新。
   */
  modelsUrl?: string;
  protocol?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** 厂商说明的 Markdown 内容。 */
  readme?: string;
  rules: TRules;
  models: ProviderModel[];
  /** 检查供应商适配文件是否有更新。 */
  checkForUpdates?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<ProviderUpdateInfo>;
  /** 获取更新文件的完整源码；写入与应用由宿主负责。 */
  updateVendor?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<string>;
  /** 未实现的方法保持缺省，调用方据此判断能力是否可用。 */
  generateImage?: GenerateMedia<ImageRequest, ProviderConfig<TRules>>;
  generateVideo?: GenerateMedia<VideoRequest, ProviderConfig<TRules>>;
  generateAudio?: GenerateMedia<AudioRequest, ProviderConfig<TRules>>;
}
