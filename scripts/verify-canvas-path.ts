/**
 * 画布等效验证：直接调用画布「视频生成」节点所用的同一条接口。
 *
 * 画布节点走的是 packages/nodeScaffold/src/nodeAi.ts 的 generateVideo：
 *   POST /api/ai/media/generate
 *   headers: Content-Type: application/json + x-toonflow-workspace: 1
 *   body: { ...input, mediaType }   —— 字段受 videoGenerationSchema(z.strictObject) 约束
 *
 * 用法：bun run scripts/verify-canvas-path.ts
 */
const payload = {
  // resolveWorkspace 要求绝对路径，且必须位于 data/workspaces 之下
  directory: "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/data/workspaces/myProject",
  mediaType: "video",
  providerId: "doubaoAccount",
  modelId: "Seedance 2.0 Fast",
  prompt: "一只橘猫趴在洒满阳光的窗台上打盹，尾巴轻轻晃动，治愈系插画风格，暖色调",
  ratio: "16:9",
  duration: 10,
};

const startedAt = Date.now();
console.log("调用画布同款接口：POST /api/ai/media/generate");
console.log("  providerId =", payload.providerId, "| modelId =", payload.modelId);

try {
  const response = await fetch("http://127.0.0.1:3000/api/ai/media/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  console.log(`\nHTTP ${response.status}｜耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  console.log(text.slice(0, 1200));
} catch (error) {
  console.log("请求失败：", error instanceof Error ? error.message : String(error));
}
