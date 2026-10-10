/**
 * 验证：豆包免费模型遇到「音频/视频参考」时是否给出明确失败提示。
 *
 * 期望：不静默忽略，也不让用户等 3 分钟 —— 应当**立即**返回一句说清
 * 「哪个参考不支持、怎么办」的错误。
 *
 * 用法：bun run scripts/verify-ref-rejected.ts
 */
const DIRECTORY = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/data/workspaces/myProject";
const ENDPOINT = "http://127.0.0.1:3000/api/ai/media/generate";

async function call(label: string, extra: Record<string, unknown>): Promise<void> {
  const body = {
    directory: DIRECTORY,
    mediaType: "video",
    providerId: "doubaoAccount",
    modelId: "Seedance 2.0 Fast",
    prompt: "一只橘猫趴在窗台上打盹",
    ratio: "16:9",
    duration: 5,
    ...extra,
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const ms = Date.now() - startedAt;
    console.log(`\n【${label}】HTTP ${response.status}｜${ms} ms`);
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || text;
    } catch { /* 原样输出 */ }
    console.log("  返回：", String(message).slice(0, 260));
  } catch (error) {
    console.log(`\n【${label}】请求异常：`, error instanceof Error ? error.message : String(error));
  }
}

// ① 带音频参考 —— 期望被明确拒绝
await call("带 1 个音频参考", {
  audios: [{ path: "assets/test-audio.wav", mimeType: "audio/wav" }],
});

// ② 带视频参考 —— 期望被明确拒绝
await call("带 1 个视频参考", {
  videos: [{ path: "assets/test-clip.mp4", mimeType: "video/mp4" }],
});

// ③ 音频 + 视频同时带 —— 期望两样都列出来
await call("音频 + 视频同时带", {
  audios: [{ path: "assets/test-audio.wav", mimeType: "audio/wav" }],
  videos: [{ path: "assets/test-clip.mp4", mimeType: "video/mp4" }],
});
