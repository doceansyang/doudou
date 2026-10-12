// 干跑：用真实适配器 + mock fetch，打印「Linke 节点这次会发给网关的请求体」。
// 不产生任何真实网络请求，不花钱。
// 运行：bun run --cwd apps/server ../../toonflow/packages/providers/scripts/_dryrun.ts
/// <reference path="../types.d.ts" />
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { mkdtemp, readFile, rm } = await import(require.resolve("@toonflow/file"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toonflowDryrun"));
const originalDataDirectory = process.env.TOONFLOW_DATA_DIR;
process.env.TOONFLOW_DATA_DIR = temporaryDirectory;
const originalFetch = globalThis.fetch;

try {
  const { loadMediaProviderSource } = await import("../../../apps/server/src/utils/media/provider");
  const source = await readFile(new URL("../src/media/JinyuDream.ts", import.meta.url), "utf8");

  const sent: { method: string; path: string; body: unknown }[] = [];
  let call = 0;
  const mockFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ method: String(init?.method ?? "GET"), path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    call++;
    // 第一次：提交任务；第二次：直接给终态
    if (call === 1) return Response.json({ task_id: "task_dryrun", status: "queued" });
    return Response.json({ code: "success", data: { status: "SUCCESS", result_url: "https://mock.invalid/out.mp4" } });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;

  const provider = await loadMediaProviderSource(source, { apiKey: "mockKey" }, undefined, mockFetch);

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
  // 完全照画布里 a658546f 那个节点的实际存值：
  //   model=["JinyuDream","seedance-2-mini"] duration=5 resolution=720p ratio=4:3
  //   mode='["imageReference:9","videoReference:3","audioReference:3"]'
  await provider.generateVideo!({
    model: "seedance-2-mini",
    prompt: "按照关联文本节点【不怕，有哥在】生成。小花形象参考，大军及衣服鸭子图案参考，家中夜晚卧室参考，小花音色",
    duration: 5,
    resolution: "720p",
    ratio: "4:3",
    mode: ["imageReference:9", "videoReference:3", "audioReference:3"] as never,
    generateAudio: true,
    images: [
      { type: "binary", data: png, mimeType: "image/png" },
      { type: "binary", data: png, mimeType: "image/png" },
      { type: "binary", data: png, mimeType: "image/png" },
    ],
    audios: [{ type: "binary", data: wav, mimeType: "audio/wav" }],
  });

  console.log("=== 真实适配器发出的请求 ===");
  for (const s of sent) {
    const body = s.body === null ? "(无)" : JSON.stringify(s.body, null, 1);
    // base64 太长，截断显示
    console.log(`${s.method} ${s.path}`);
    console.log(body.length > 1400 ? body.slice(0, 1400) + "\n  …（截断）" : body);
    console.log();
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalDataDirectory === undefined) delete process.env.TOONFLOW_DATA_DIR;
  else process.env.TOONFLOW_DATA_DIR = originalDataDirectory;
  assertPath();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
function assertPath() {
  if (!resolve(temporaryDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowDryrun`)) throw new Error("临时目录异常");
}
process.exit(0);
