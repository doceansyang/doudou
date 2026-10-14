import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { t } from "@/lib/i18n";

const router = Router();

/**
 * 配置里所有「密钥类」字段名。
 *
 * ★★ 为什么需要（2026-10-14）：`save` 收到的是前端提交的**全量设置**，落盘时会把磁盘上的
 *    整份 settings 覆盖掉。实测「重启 / 更新软件后 `customProviders[*].apiKey` 变成 0 位、
 *    用户每次都得重填」—— 密钥被空值抹掉是用户直接能感知的损失。
 *    这里统一做「**空值不覆盖非空**」的合并：想换密钥直接填新的即可，空值抹不掉已有的。
 */
const secretFields = new Set([
  "apiKey",
  "uploadApiKey",
  "pluginMarketApiKey",
  "secretKey",
  "accessKey",
  "accessKeySecret",
  "password",
  "token",
]);

/**
 * 把 `next` 里被带成空的密钥字段回填为 `previous` 中的非空值（就地修改 `next`）。
 * 数组按 `id` 对齐（供应商列表就靠它匹配），非对象元素直接跳过。
 */
function keepExistingSecrets(previous: unknown, next: unknown): void {
  if (Array.isArray(previous) && Array.isArray(next)) {
    for (const item of next) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      const match = previous.find(candidate =>
        candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === id);
      keepExistingSecrets(match, item);
    }
    return;
  }
  if (!previous || typeof previous !== "object" || !next || typeof next !== "object") return;
  const before = previous as Record<string, unknown>;
  const target = next as Record<string, unknown>;
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === "string" && secretFields.has(key) && !value.trim()
      && typeof before[key] === "string" && (before[key] as string).trim()) {
      target[key] = before[key];
      continue;
    }
    keepExistingSecrets(before[key], value);
  }
}

export default router.put("/", validateFields({ settings: z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, { error: () => t`系统提示词不能超过 ${maxSystemPromptLength} 个字符` }).optional(),
  desktopUpdateSource: z.enum(["official", "github", "custom"]).optional(),
  desktopUpdateCustomUrl: z.string().max(2048).refine(value => !value || u.desktop.isValidUpdateUrl(value),
    "自定义更新源必须是不含账号、查询参数或锚点的 HTTP(S) 地址").optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
})).refine(value => value.desktopUpdateSource !== "custom" || !!value.desktopUpdateCustomUrl, {
  path: ["desktopUpdateCustomUrl"], message: "选择自定义更新源前，请先填写有效地址",
}) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { settings } = req.body;
  u.removeLegacySettings(settings);
  const previousSettings = u.conf.get("settings", {});
  // ★★ 密钥保护：空值不覆盖已有的非空密钥（见上方 keepExistingSecrets 的说明）。
  keepExistingSecrets(previousSettings, settings);
  u.conf.set("settings", settings);
  const [models] = await Promise.all([u.ai.refreshProviderModels(previousSettings), u.mcpRuntime.reloadMcpRuntime()]);
  res.json(success(models, "设置已保存"));
});
