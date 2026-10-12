import JinyuDream from "@toonflow/providers/language/JinyuDream";
import JinyuDreamMedia from "@toonflow/providers/media/JinyuDream";
import conf from "@/utils/conf";
import { fetchProviderModels } from "@/utils/ai/models";
import { getMediaProviderApiKey, refreshMediaProviderModels } from "@/utils/media/provider";

let initialization: Promise<void> | undefined;

function normalizeApiKey(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
}

function getLanguageProvider(settings: Record<string, unknown>) {
  const providers = settings.customProviders;
  if (!Array.isArray(providers)) return;
  return providers.find(item => typeof item?.id === "string" && item.id.toLowerCase() === JinyuDream.id.toLowerCase()
    && typeof item.apiUrl === "string" && URL.canParse(item.apiUrl) && new URL(item.apiUrl).origin === new URL(JinyuDream.apiUrl).origin);
}

async function refreshLanguageModels(previousSettings?: Record<string, unknown>) {
  const provider = getLanguageProvider(conf.get("settings", {}));
  const apiKey = normalizeApiKey(provider?.apiKey);
  if (!apiKey || (previousSettings && apiKey === normalizeApiKey(getLanguageProvider(previousSettings)?.apiKey))) return;
  const fetched = await fetchProviderModels({ apiUrl: provider.apiUrl, protocol: provider.protocol, apiKey });
  // ⚠️ 文本清单必须**剔掉媒体模型**。网关 `/v1/models` 是**全量**返回 ——
  //    文本、图片、视频混在同一个数组里，而且不给类型字段（只有 gpt-image-2 带了
  //    一个 image-generation 标记，其余全是 ["openai"]）。照单全收的后果：
  //    `seedance-2`、`grok-video-1.5`、`wan3.0-video` 这些视频模型会出现在
  //    「设置 → 文本模型」和**文本节点**的下拉里。
  //    判据用媒体供应商的**权威清单**按 id 精确匹配，不去猜模型名。
  const mediaIds = new Set(JinyuDreamMedia.models.map(model => model.id));
  const models = fetched.filter(model => !mediaIds.has(model.id));
  if (!models.length) throw new Error("未获取到文本模型，保留原有列表");
  const current = conf.get("settings.customProviders");
  if (!Array.isArray(current)) return;
  const index = current.findIndex(item => item?.id === provider.id && item.apiUrl === provider.apiUrl
    && item.protocol === provider.protocol && item.apiKey === provider.apiKey);
  if (index === -1) return;
  const providers = current.map((item, itemIndex) => itemIndex === index ? { ...item, models } : item);
  conf.set("settings.customProviders", providers);
  return providers;
}

async function refreshMediaModels(previousSettings: Record<string, unknown> | undefined, errors: string[]) {
  const apiKey = getMediaProviderApiKey(JinyuDreamMedia.id);
  const configs = previousSettings?.mediaProviderConfigs as Record<string, { apiKey?: unknown }> | undefined;
  if (!apiKey || (previousSettings && apiKey === normalizeApiKey(configs?.[JinyuDreamMedia.id]?.apiKey))) return;
  try {
    // ⚠️ 只调一次、**不带 ?type=**。网关忽略该参数（四种 type 返回同一批 id），
    //    按类型分多轮只会让同一份列表被反复读、改写，还平白多出「该类型没模型」的失败轮。
    //    分类交给本地清单完成 —— 见 refreshMediaProviderModels 里的优先级说明。
    return await refreshMediaProviderModels(`${JinyuDreamMedia.id}.ts`, undefined, undefined, apiKey);
  } catch (error) {
    if (getMediaProviderApiKey(JinyuDreamMedia.id) !== apiKey) return;
    errors.push(`Linke 媒体模型更新失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function refreshProviderModels(previousSettings?: Record<string, unknown>) {
  const errors: string[] = [];
  const [language, media] = await Promise.allSettled([refreshLanguageModels(previousSettings), refreshMediaModels(previousSettings, errors)]);
  for (const [result, label] of [[language, "文本"], [media, "媒体"]] as const) {
    if (result.status === "rejected") errors.push(`Linke ${label}模型更新失败：${result.reason instanceof Error ? result.reason.message : "未知错误"}`);
  }
  return {
    ...(language.status === "fulfilled" && language.value ? { customProviders: conf.get("settings.customProviders") as typeof language.value } : {}),
    ...(media.status === "fulfilled" && media.value ? { mediaProvider: media.value } : {}),
    ...(errors.length ? { modelRefreshErrors: errors } : {}),
  };
}

export default function initializeProviderModels() {
  // ACT: 每个进程启动时仅尝试一次；失败保留已有模型，下次启动再更新。
  return initialization ??= refreshProviderModels().then(result => {
    result.modelRefreshErrors?.forEach(error => console.warn(error));
  });
}
