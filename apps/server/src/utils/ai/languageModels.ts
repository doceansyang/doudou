import JinyuDreamMedia from "@toonflow/providers/media/JinyuDream";
import { listMediaProviders } from "@/utils/media/provider";

/**
 * 「文本模型」清单的过滤 —— 本文件是**唯一**的判据来源。
 *
 * ## 为什么必须有它
 * 网关 `GET /v1/models` 是**全量**返回：文本、图片、视频混在同一个数组里，而且
 * **不给类型字段**（只有 `gpt-image-2` 带了个 `supported_endpoint_types`，其余全是
 * `["openai"]`），`?type=` 也被忽略。照单全收的后果：
 *   · 「设置 → 文本模型」里会冒出 `seedance-2`、`wan3.0-video`、`gpt-image-2`；
 *   · **文本节点**的模型下拉里也会出现它们（选了必然报错）。
 *
 * ## 判据 = 媒体供应商的模型 id（精确匹配，不猜名字）
 * 两个来源取**并集**：
 *   ① 内置源码 `packages/providers/src/media/JinyuDream.ts` 的 `models`；
 *   ② 磁盘上的 `<数据目录>/providers/*.ts` —— 启动刷新会把网关**新加的**模型
 *      按规则自动归类并写回磁盘（见 `utils/media/modelType.ts`），所以只看内置清单
 *      是不够的：新模型会从"文本列表"这个口子漏进来。
 *
 * ⚠️ 读磁盘失败（目录还没建、文件损坏）时**只用内置清单**，绝不因此让「获取模型」整个失败。
 */
export async function mediaModelIds() {
  const ids = new Set(JinyuDreamMedia.models.map(model => model.id));
  try {
    for (const provider of await listMediaProviders()) {
      for (const model of provider.models ?? []) if (model?.id) ids.add(model.id);
    }
  } catch {
    // 只用内置清单兜底。
  }
  return ids;
}

/** 从一份 `/v1/models` 的结果里剔掉媒体模型。 */
export async function filterLanguageModels<T extends { id: string }>(models: T[]): Promise<T[]> {
  const ids = await mediaModelIds();
  return models.filter(model => !ids.has(model.id));
}
