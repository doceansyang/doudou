import { z } from "zod";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

const relativePath = z.string().min(1).max(2048).refine(
  path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含空路径段或 ..",
);
const imageReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) });
const videoReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
const audioReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i) });
const sharedFields = {
  // ⚠️ 首字母**必须允许大写**。原来是 /^[a-z][a-zA-Z0-9]{0,95}$/，只认小驼峰，
  //    于是 providerId="JinyuDream"（Linke 的适配器 id，文件名就叫 JinyuDream.ts）
  //    在**出网之前**就被这里 400 掉，前端只看到「参数错误：无效字符串」——
  //    表现就是「Linke 的视频/图片模型怎么都用不了」，而网关那边其实好好的
  //    （同参数直接打 api.linke.link 一切正常）。
  //    内置适配器里 doubaoAccount 是小写开头，只有 JinyuDream 带大写（apiMart / metaso
  //    这两支已在早期下线，当时也是小写开头）—— 这正是「别的厂家能用、只有 Linke 不行」的原因。
  //    这里放宽到「字母开头」，前后端与磁盘上的适配器 id 都不用改（改 id 会打断
  //    画布节点里已存的 model 值与设置里的 mediaProviderConfigs 键）。
  providerId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100000),
  outputDirectory: relativePath.optional(),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "参考数量必须在 1 到 256 之间");

export const listMediaModelsSchema = z.strictObject({});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  size: z.string().trim().min(1).max(64).optional(),
});
export const videoGenerationSchema = z.strictObject({
  ...sharedFields,
  videos: z.array(videoReference).max(64).optional(),
  audios: z.array(audioReference).max(64).optional(),
  firstFrame: imageReference.optional(),
  lastFrame: imageReference.optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  generateAudio: z.boolean().optional(),
  mode: z.union([
    z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"]),
    z.array(referenceMode).min(1).max(3),
  ]).optional(),
});
export const audioGenerationSchema = z.strictObject({
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: sharedFields.prompt,
  outputDirectory: sharedFields.outputDirectory,
  images: sharedFields.images,
  audios: z.array(audioReference).max(64).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
  language: z.string().trim().min(1).max(64).optional(),
  format: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
});
