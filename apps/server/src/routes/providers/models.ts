import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { filterLanguageModels } from "@/utils/ai/languageModels";
import u from "@/utils";

const router = Router();

export default router.post("/", validateFields({
  apiUrl: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "请填写不含查询参数的 HTTP API 基础地址"),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  apiKey: z.string().max(8192),
  // ⚠️ 默认 `language`：本接口的调用方（设置 → 文本模型 的「获取模型」与编辑弹窗）
  //    全都要的是**文本模型**。网关的 `/v1/models` 是文本 + 图片 + 视频混在一起的
  //    全量列表，不过滤的话 `seedance-2` / `gpt-image-2` 会被当成文本模型存进
  //    `settings.customProviders`，随后出现在**文本节点**的下拉里。
  //    要原始全量列表（调试用）传 `kind: "all"`。
  kind: z.enum(["language", "all"]).default("language"),
}), async (req, res) => {
  const { apiUrl, protocol, apiKey, kind } = req.body as { apiUrl: string; protocol: string; apiKey: string; kind: "language" | "all" };
  // 密钥为空时也要在这里说清楚：否则会带着空 Bearer 去请求，
  // 对方返回 401，界面只显示「HTTP 401，请检查 API 地址、协议和密钥」——
  // 用户会以为地址或协议填错了，而真实原因只是没填密钥。
  if (!apiKey.trim()) {
    return res.status(400).json(
      error("请先填写 API 密钥，再获取模型列表", null, 400),
    );
  }
  const models = await u.ai.fetchProviderModels({ apiUrl, protocol, apiKey });
  res.json(success(kind === "all" ? models : await filterLanguageModels(models)));
});
