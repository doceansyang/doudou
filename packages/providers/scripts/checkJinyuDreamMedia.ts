// 运行：bun run --cwd apps/server ../../packages/providers/scripts/checkJinyuDreamMedia.ts [适配文件路径]
// 全部请求由本地 mock 处理 —— 不产生任何真实网络请求，也不消耗额度。
//
// 这份检查替换掉了原来的 checkJinyuDreamAudio.ts：那份测的是**原版 Toonflow 私有后端**的
// 协议（`/v1/tts/create`、`/v1/image/generateImage`、`/v1/video/generateVideo`），
// 而 `api.linke.link` 是 new-api 网关，这些路径在该域名上全部 404（实测）。
// 协议变了，检查也得跟着变，否则它会一边"通过"一边掩盖真实故障。
/// <reference path="../types.d.ts" />
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { mkdtemp, readFile, rm } = await import(require.resolve("@toonflow/file"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toonflowJinyuDreamMedia"));
const originalDataDirectory = process.env.TOONFLOW_DATA_DIR;
process.env.TOONFLOW_DATA_DIR = temporaryDirectory;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let onWait: (() => void) | undefined;
let waits = 0;
// ACT: 仅压缩供应商轮询的三秒等待，保留真实取消事件和 timer 清理。
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (delay !== 3000) return originalSetTimeout(callback, delay, ...args);
  waits++;
  return originalSetTimeout(() => { onWait?.(); callback(...args); }, 0);
}) as typeof setTimeout;
globalThis.fetch = Object.assign(async () => { throw new Error("检查禁止真实网络请求"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;

try {
  const { loadMediaProviderSource } = await import("../../../apps/server/src/utils/media/provider");
  const source = await readFile(process.argv[2] ? resolve(process.argv[2]) : new URL("../src/media/JinyuDream.ts", import.meta.url), "utf8");

  /** 建一个带 mock fetch 的供应商实例；responses 按调用顺序出队。 */
  async function createProvider(responses: (() => unknown)[], signal?: AbortSignal, httpStatus = 200) {
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
    const mockFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string);
      assert.equal(url.origin, "https://api.linke.link");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer mockKey");
      init?.signal?.throwIfAborted();
      calls.push({ path: url.pathname, method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : {} });
      const next = responses.shift();
      if (!next) throw new Error(`mock 未准备响应：${init?.method} ${url.pathname}`);
      return Response.json(next(), { status: httpStatus });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const provider = await loadMediaProviderSource(source, { apiKey: " Bearer mockKey " }, signal, mockFetch);
    return { provider, calls };
  }

  // ── 1) 视频：异步任务协议（提交拿 task_id → 轮询到终态） ────────────────
  // 提交响应的结构照抄**真实网关**：{created_at, id, model, status, task_id}。
  const video = await createProvider([
    () => ({ created_at: 1, id: "task_mock", model: "seedance-2", status: "queued", task_id: "task_mock" }),
    // 终态也照抄真实结构（顶层 status + result_url，内层还嵌着 result.data[].url）。
    () => ({ code: "success", message: "", data: { status: "SUCCESS", progress: "100%", quota: 0, fail_reason: "",
      result_url: "https://mock.invalid/out.mp4",
      data: { status: "completed", result: { type: "video", data: [{ format: "mp4", url: "https://mock.invalid/inner.mp4" }] } } } }),
  ]);
  const videoOut = await video.provider.generateVideo!({
    model: "seedance-2", prompt: "一只橘猫在窗台上打盹", duration: 5, resolution: "720p", ratio: "16:9", generateAudio: false,
  });
  assert.deepEqual(video.calls.map(call => `${call.method} ${call.path}`), [
    "POST /v1/video/generations",
    "GET /v1/video/generations/task_mock",
  ]);
  assert.equal(video.calls[0]!.body.model, "seedance-2");
  assert.equal(video.calls[0]!.body.duration, 5);
  assert.equal(video.calls[0]!.body.resolution, "720p");
  assert.equal(video.calls[0]!.body.ratio, "16:9");
  assert.equal(video.calls[0]!.body.generate_audio, false);
  assert.equal(videoOut[0]?.mediaType, "video");
  assert.equal(videoOut[0]?.type === "url" && videoOut[0].url, "https://mock.invalid/out.mp4");

  // 顶层没有 result_url 时，必须能钻进 result.data[].url 取到地址（两种结构都要兼容）。
  const nested = await createProvider([
    () => ({ task_id: "task_nested" }),
    () => ({ code: "success", data: { status: "SUCCESS", data: { status: "completed",
      result: { type: "video", data: [{ format: "mp4", url: "https://mock.invalid/deep.mp4" }] } } } }),
  ]);
  const nestedOut = await nested.provider.generateVideo!({ model: "wan3.0-video", prompt: "海浪" });
  assert.equal(nestedOut[0]?.type === "url" && nestedOut[0].url, "https://mock.invalid/deep.mp4");

  // 中途 in_progress 必须继续轮询，不能提前放弃。
  const streaming = await createProvider([
    () => ({ task_id: "task_slow" }),
    () => ({ data: { status: "IN_PROGRESS", progress: "50%" } }),
    () => ({ data: { status: "IN_PROGRESS", progress: "90%" } }),
    () => ({ data: { status: "SUCCESS", result_url: "https://mock.invalid/late.mp4" } }),
  ]);
  await streaming.provider.generateVideo!({ model: "seedance-2", prompt: "慢任务" });
  assert.equal(streaming.calls.length, 4);
  assert.ok(waits > 0, "轮询之间必须真的等待");

  // ── 2) 图片：OpenAI 风格**同步**返回，不该去轮询 ──────────────────────
  const image = await createProvider([() => ({ data: [{ url: "https://mock.invalid/pic.png" }] })]);
  const imageOut = await image.provider.generateImage!({ model: "gpt-image-2", prompt: "一张海报", size: "1K", ratio: "1:1" });
  assert.deepEqual(image.calls.map(call => `${call.method} ${call.path}`), ["POST /v1/images/generations"]);
  // 档位 + 比例要换算成 gpt-image-2 唯一认识的 WxH 像素尺寸。
  assert.equal(image.calls[0]!.body.size, "1024x1024");
  assert.equal(image.calls[0]!.body.n, 1);
  assert.equal(imageOut[0]?.mediaType, "image");
  assert.equal(imageOut[0]?.type === "url" && imageOut[0].url, "https://mock.invalid/pic.png");

  const ratio = await createProvider([() => ({ data: [{ url: "https://mock.invalid/tall.png" }] })]);
  await ratio.provider.generateImage!({ model: "gpt-image-2", prompt: "竖版", size: "2K", ratio: "2:3" });
  assert.equal(ratio.calls[0]!.body.size, "1600x2400");

  // ── 3) 失败与异常路径 ────────────────────────────────────────────────
  const failed = await createProvider([
    () => ({ task_id: "task_fail" }),
    () => ({ code: "success", data: { status: "FAILURE", fail_reason: "内容审核未通过" } }),
  ]);
  await assert.rejects(failed.provider.generateVideo!({ model: "seedance-2", prompt: "x" }), /内容审核未通过/);

  const noTask = await createProvider([() => ({ status: "queued" })]);
  await assert.rejects(noTask.provider.generateVideo!({ model: "seedance-2", prompt: "x" }), /任务 ID/);

  const emptyDone = await createProvider([() => ({ task_id: "t" }), () => ({ data: { status: "SUCCESS" } })]);
  await assert.rejects(emptyDone.provider.generateVideo!({ model: "seedance-2", prompt: "x" }), /没有返回视频地址/);

  const httpFailure = await createProvider([() => ({ error: { message: "额度不足" } })], undefined, 402);
  await assert.rejects(httpFailure.provider.generateVideo!({ model: "seedance-2", prompt: "x" }), /额度不足/);

  const noKey = await loadMediaProviderSource(source, { apiKey: "" });
  await assert.rejects(noKey.generateVideo!({ model: "seedance-2", prompt: "x" }), /API Key/);

  // ── 4) 取消：轮询中被 abort 必须立刻抛 AbortError，且不再多发请求 ──────
  const controller = new AbortController();
  const canceled = await createProvider([
    () => ({ task_id: "task_abort" }),
    () => ({ data: { status: "IN_PROGRESS" } }),
  ], controller.signal);
  onWait = () => controller.abort();
  await assert.rejects(canceled.provider.generateVideo!({ model: "seedance-2", prompt: "x" }), { name: "AbortError" });
  onWait = undefined;
  assert.equal(canceled.calls.length, 2, "取消后不得再次轮询");

  console.log("Linke 媒体检查通过：视频异步任务（提交/轮询/嵌套结构/失败）、图片同步返回与尺寸换算、"
    + "HTTP 错误正文、缺 Key、轮询中取消；真实网络请求 0 次。");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (originalDataDirectory === undefined) delete process.env.TOONFLOW_DATA_DIR;
  else process.env.TOONFLOW_DATA_DIR = originalDataDirectory;
  assert.ok(resolve(temporaryDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowJinyuDreamMedia`));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
// ACT: 宿主配置会启动文件监听；完成临时目录清理后退出单次检查。
process.exit(0);
