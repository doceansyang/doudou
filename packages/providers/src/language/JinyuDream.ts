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
  version: "2.0.0",
  apiUrl: "https://api.linke.link/v1",
  protocol: "openai-completions",
  readme: "## JinyuTV 官方中转平台\n\n提供文本模型服务。\n\n[前往中转平台](https://api.linke.link/)",
  rules,
  models: [],
} satisfies ProviderDefinition<typeof rules>;
