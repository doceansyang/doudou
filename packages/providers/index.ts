/// <reference path="./types.d.ts" />

import JinyuDreamLanguage from "./src/language/JinyuDream";
import deepSeek from "./src/language/deepSeek";
import JinyuDreamMedia from "./src/media/JinyuDream";
import doubaoAccount from "./src/media/doubaoAccount";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [JinyuDreamLanguage, deepSeek] as const;
// 只保留官方中转平台（Linke）与豆包账号两条通道。
// APIMart（apiMart）与秘塔版 MiniMax H3（metaso）已按用户要求**整体下线**，
// 源码文件也一并删除（`src/media/apiMart.ts` / `metaso.ts`）—— 否则
// apps/server/src/app.ts 的 autoInstallProviders 会把它俩重新铺回 data/providers 并出现在节点下拉里。
export const mediaProviders = [JinyuDreamMedia, doubaoAccount] as const;
