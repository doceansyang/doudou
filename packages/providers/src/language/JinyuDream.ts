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
  readme: "## JinyuTV 官方中转平台\n\n提供文本模型服务。\n\n[前往中转平台](https://api.linke.link/)",
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
