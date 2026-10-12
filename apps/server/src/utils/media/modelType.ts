/**
 * 判断一个网关模型属于哪一类。
 *
 * 为什么需要它：网关（new-api）**只给 id、不给类型** —— `/v1/models` 没有 type 字段，
 * `?type=` 参数也被忽略（四种取值返回同一批 id）。而 linke 那边会**一直加模型**，
 * 每加一个就回来改一次本地清单不现实，所以要有能自动归类的规则。
 *
 * 优先级：
 *   ① **网关的接口能力声明** `supported_endpoint_types`：图片模型会明确带
 *      `image-generation`（实测 `gpt-image-2` 与 `gpt-image-2.5-flare` 都带），这条最硬。
 *   ② **模型名启发式**：视频 / 音频模型没有能力标记，只能看名字里的语义词
 *      （`seedance` / `wan3.0-video` / `kling` / `veo` / `suno` …）。
 *      这条就是给"以后新加的模型"准备的：`seedream-4`、`kling-v2` 不改代码也能归类。
 *   ③ 推不出来就**不猜**：返回 undefined，由调用方跳过并记日志。
 *      宁可这个模型暂时不出现，也不能把文本模型塞进视频节点下拉里
 *      —— 用户报过的"乱放"就是这么来的。
 *
 * ⚠️ 这里**故意不写文本模型的规则**：匹配不上自然会落到 ③ 被跳过；而文本模型名里
 *    可能出现 `image`（`gpt-4-vision-image` 之类），先认文本反而会误伤媒体。
 *
 * 单独成文件是为了能**脱离 server 依赖跑单测**（见 `scripts/checkModelType.ts`）。
 */

/** 图片类特征词。 */
const imageHints = /(image|dall-?e|flux|seedream|nano-?banana|stable-?diffusion|sdxl|imagen|kolors|midjourney|ideogram|recraft|\bsd[0-9])/i;
/** 视频类特征词。 */
const videoHints = /(video|seedance|kling|veo\b|sora|hailuo|pika|runway|ltx|hunyuan|vidu|luma|mochi|cogvideo|wan[0-9.]|wan-)/i;
/** 音频类特征词。 */
const audioHints = /(tts|speech|\baudio|voice|music|suno|elevenlabs|cosyvoice|whisper)/i;

export function inferModelType(id: string, model: Record<string, unknown> = {}): "image" | "video" | "audio" | undefined {
  // ① 接口能力：`image-generation` 是图片模型的专属标记
  const endpoints = [model.supported_endpoint_types, model.supportedEndpointTypes].find(Array.isArray) as unknown[] | undefined;
  if (endpoints?.some(item => typeof item === "string" && /image-generation/i.test(item))) return "image";
  // ② 名称启发式（三组特征词互不重叠，顺序：图片 → 视频 → 音频）
  if (imageHints.test(id)) return "image";
  if (videoHints.test(id)) return "video";
  if (audioHints.test(id)) return "audio";
  // ③ 不猜
  return undefined;
}
