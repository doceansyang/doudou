/// <reference path="./types.d.ts" />

import JinyuDreamLanguage from "./src/language/JinyuDream";
import JinyuDreamMedia from "./src/media/JinyuDream";
import doubaoAccount from "./src/media/doubaoAccount";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

// 文本供应侧同样只留 Linke 一条。
// DeepSeek（deepSeek，models 为空的历史占位）已按用户要求下线：它只会在「文本模型 →
// 供应商」里多出一个用不了的非 Linke 条目，源码文件与 package exports 一并删除。
export const languageProviders = [JinyuDreamLanguage] as const;
// 媒体供应侧只保留官方中转平台（Linke）与豆包账号两条通道。
// APIMart（apiMart）与秘塔版 MiniMax H3（metaso）已按用户要求**整体下线**，
// 源码文件也一并删除（`src/media/apiMart.ts` / `metaso.ts`）。
// ⚠️ 只删源码不够：`<实例>/data/providers` 里**已经铺进去的旧文件**不会被覆盖掉
//    （initializePlugins 只做新增/覆盖），所以 app.ts 启动时会主动清理这几个已下线的文件名 ——
//    否则老客户的模型下拉里永远还留着它们。
export const mediaProviders = [JinyuDreamMedia, doubaoAccount] as const;
