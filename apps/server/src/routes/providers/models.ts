import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = Router();

export default router.post("/", validateFields({
  apiUrl: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "请填写不含查询参数的 HTTP API 基础地址"),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  apiKey: z.string().max(8192),
}), async (req, res) => {
  const { apiUrl, protocol, apiKey } = req.body as { apiUrl: string; protocol: string; apiKey: string };
  // 密钥为空时也要在这里说清楚：否则会带着空 Bearer 去请求，
  // 对方返回 401，界面只显示「HTTP 401，请检查 API 地址、协议和密钥」——
  // 用户会以为地址或协议填错了，而真实原因只是没填密钥。
  if (!apiKey.trim()) {
    return res.status(400).json(
      error("请先填写 API 密钥，再获取模型列表", null, 400),
    );
  }
  res.json(success(await u.ai.fetchProviderModels({ apiUrl, protocol, apiKey })));
});
