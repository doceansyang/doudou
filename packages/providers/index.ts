/// <reference path="./types.d.ts" />

import JinyuDreamLanguage from "./src/language/JinyuDream";
import deepSeek from "./src/language/deepSeek";
import JinyuDreamMedia from "./src/media/JinyuDream";
import apiMart from "./src/media/apiMart";
import metaso from "./src/media/metaso";
import doubaoAccount from "./src/media/doubaoAccount";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [JinyuDreamLanguage, deepSeek] as const;
export const mediaProviders = [JinyuDreamMedia, apiMart, metaso, doubaoAccount] as const;
