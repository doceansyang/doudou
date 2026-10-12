const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

export default {
  id: "JinyuDream" as const,
  label: "Linke",
  version: "2.0.1",
  apiUrl: "https://api.linke.link/v1",
  protocol: "openai-completions",
  // 文案与「媒体模型」那份保持同一格式（正文 + 「🔗 通过此 [注册链接](…) 注册即可开用。」）。
  // 链接色由 messageMarkdown 的 --primary（= --ui-brand-foreground）决定，随主题走，别写死颜色。
  readme: "## JinyuTV 官方中转平台\n\n提供文本模型服务。\n\n🔗 通过此 [注册链接](https://api.linke.link/register) 注册即可开用。",
  rules,
  /*
   * 这里是**大语言模型**清单（对应「设置 → 文本模型」与文本节点）。
   * 运行时由服务端在程序启动时从 `/v1/models` 拉取后写入 settings.customProviders，
   * 所以本数组留空即可。
   *
   * ⚠️ 拉取时必须**剔掉媒体模型**：网关的 /v1/models 是全量返回且不带类型，
   *    seedance-2 / grok-video-1.5 / wan3.0-video / gpt-image-2 会和文本模型混在一起。
   *    过滤规则见 apps/server/src/utils/ai/initialize.ts 的 refreshLanguageModels
   *    —— 按媒体供应商的权威清单（media/JinyuDream.ts 的 models）精确匹配 id 剔除。
   *    媒体模型属于「设置 → 媒体模型」（图片 + 视频），不要放进这里。
   */
  models: [],
} satisfies ProviderDefinition<typeof rules>;
