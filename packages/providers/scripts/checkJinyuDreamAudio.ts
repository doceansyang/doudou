// 运行：bun run --cwd apps/server ../../packages/providers/scripts/checkJinyuDreamAudio.ts [适配文件路径]；全部请求由本地 mock 处理。
/// <reference path="../types.d.ts" />
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { mkdtemp, readFile, rm } = await import(require.resolve("@toonflow/file"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toonflowJinyuDreamAudio"));
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
  const outputUrl = "https://mock.invalid/audio.mp3";
  const defaultResult = { status: "completed", data: { data: outputUrl } };

  async function createProvider(results: unknown[] = [defaultResult], signal?: AbortSignal, creation: unknown = { data: "mockTask" }, httpStatus = 200) {
    const calls: { path: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
    const mockFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string);
      assert.equal(url.origin, "https://api.linke.link");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer mockKey");
      assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
      init?.signal?.throwIfAborted();
      const path = url.pathname;
      const body = JSON.parse(String(init?.body));
      calls.push({ path, body, signal: init?.signal });
      const isCreate = /\/(create|generateImage|generateVideo)$/.test(path);
      if (!isCreate) assert.deepEqual(body, { taskICode: "mockTask" });
      return Response.json(isCreate ? creation : results.shift() ?? defaultResult, { status: httpStatus });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const provider = await loadMediaProviderSource(source, { apiKey: " Bearer mockKey " }, signal, mockFetch);
    assert.equal(typeof provider.generateAudio, "function");
    return { provider, calls };
  }

  const request: AudioRequest = { model: "seed-audio-1.0", text: "测试音频" };
  const basic = await createProvider();
  const output = await basic.provider.generateAudio!(request);
  assert.deepEqual(basic.calls.map(call => call.path), ["/v1/tts/create", "/v1/tts/getAudioStatus"]);
  assert.equal(basic.calls[0]!.body.model, request.model);
  assert.equal(basic.calls[0]!.body.text, request.text);
  assert.equal(basic.calls[0]!.body.format, "mp3");
  assert.equal(basic.calls[0]!.body.sampleRate, 24000);
  assert.equal(basic.calls[0]!.body.speechRate ?? 0, 0);
  assert.equal(basic.calls[0]!.body.loudnessRate ?? 0, 0);
  assert.equal(basic.calls[0]!.body.pitchRate ?? 0, 0);
  assert.equal(output[0]?.mediaType, "audio");
  assert.equal(output[0]?.type, "url");
  assert.equal(output[0]?.type === "url" && output[0].url, outputUrl);
  assert.equal(output[0]?.mimeType, "audio/mpeg");

  const imageBytes = new Uint8Array([1, 2, 3]);
  const audioBytes = new Uint8Array([4, 5, 6]);
  const imageBase64 = Buffer.from(imageBytes).toString("base64");
  const audioBase64 = Buffer.from(audioBytes).toString("base64");
  const references = await createProvider();
  await references.provider.generateAudio!({ ...request,
    images: [
      { type: "url", url: "https://mock.invalid/image.png" },
      { type: "binary", data: imageBytes, mimeType: "image/png" },
      { type: "base64", data: imageBase64, mimeType: "image/png" },
      { type: "base64", data: `data:image/png;base64,${imageBase64}`, mimeType: "image/png" },
    ],
    audios: [
      { type: "url", url: "https://mock.invalid/audio.wav" },
      { type: "binary", data: audioBytes, mimeType: "audio/wav" },
      { type: "base64", data: audioBase64, mimeType: "audio/wav" },
      { type: "base64", data: `data:audio/wav;base64,${audioBase64}`, mimeType: "audio/wav" },
    ],
  });
  assert.deepEqual((references.calls[0]!.body.references as unknown[]).map(item => JSON.stringify(item)).sort(), [
    { image_url: "https://mock.invalid/image.png" },
    { image_data: imageBase64 }, { image_data: imageBase64 }, { image_data: imageBase64 },
    { audio_url: "https://mock.invalid/audio.wav" },
    { audio_data: audioBase64 }, { audio_data: audioBase64 }, { audio_data: audioBase64 },
  ].map(item => JSON.stringify(item)).sort());

  for (const [speed, volume, pitch, expected] of [
    [0.5, 20 * Math.log10(0.5), -12, -50], [1, 0, 0, 0], [2, 20 * Math.log10(2), 12, 100],
  ] as const) {
    const mapping = await createProvider();
    await mapping.provider.generateAudio!({ ...request, speed, volume, pitch });
    assert.equal(mapping.calls[0]!.body.speechRate, expected);
    assert.equal(mapping.calls[0]!.body.loudnessRate, expected);
    assert.equal(mapping.calls[0]!.body.pitchRate, pitch);
  }
  for (const [format, mimeType] of [["wav", "audio/wav"], ["mp3", "audio/mpeg"], ["pcm", "audio/pcm"], ["ogg_opus", "audio/ogg"]]) {
    for (const sampleRate of [8000, 16000, 22050, 24000, 32000, 44100, 48000]) {
      const options = await createProvider();
      const assets = await options.provider.generateAudio!({ ...request, format, sampleRate });
      assert.equal(options.calls[0]!.body.format, format);
      assert.equal(options.calls[0]!.body.sampleRate, sampleRate);
      assert.equal(assets[0]?.mimeType, mimeType);
    }
  }
  const promptOnly = await createProvider();
  await promptOnly.provider.generateAudio!({ model: request.model, prompt: "提示词音频" });
  assert.equal(promptOnly.calls[0]!.body.text, "提示词音频");

  for (const invalid of [
    { text: " " }, { format: "flac" }, { sampleRate: 12000 }, { sampleRate: NaN },
    { speed: 0.49 }, { speed: 2.01 }, { speed: NaN },
    { volume: -6.1 }, { volume: 6.1 }, { volume: Infinity },
    { pitch: -12.1 }, { pitch: 12.1 }, { pitch: NaN },
    { images: [{ type: "url", url: "file:///image.png" }] },
    { audios: [{ type: "url", url: "ftp://mock.invalid/audio.wav" }] },
    { images: [{ type: "base64", data: imageBase64, mimeType: "audio/wav" }] },
    { audios: [{ type: "base64", data: audioBase64, mimeType: "image/png" }] },
    { images: [{ type: "base64", data: "invalid!", mimeType: "image/png" }] },
    { audios: [{ type: "binary", data: new Uint8Array(), mimeType: "audio/wav" }] },
  ]) {
    const boundary = await createProvider();
    await assert.rejects(boundary.provider.generateAudio!({ ...request, ...invalid } as AudioRequest));
    assert.equal(boundary.calls.length, 0, JSON.stringify(invalid));
  }

  const pending = await createProvider([{ status: "pending", data: {} }, { data: { status: "success", data: outputUrl } }]);
  await pending.provider.generateAudio!(request);
  assert.equal(pending.calls.length, 3);
  assert.ok(waits > 0);
  for (const status of ["failed", "failure", "error", "rejected"]) {
    const failed = await createProvider([{ status, data: { failReason: "供应商生成失败详情" } }]);
    await assert.rejects(failed.provider.generateAudio!(request), /供应商生成失败详情/);
    assert.equal(failed.calls.length, 2);
  }
  const httpFailure = await createProvider([], undefined, { message: "接口请求失败详情" }, 400);
  await assert.rejects(httpFailure.provider.generateAudio!(request), /接口请求失败详情/);
  const noTask = await createProvider([], undefined, { data: "" });
  await assert.rejects(noTask.provider.generateAudio!(request), /任务\s*ID/);
  const badResult = await createProvider([{ status: "completed", data: { data: "file:///audio.mp3" } }]);
  await assert.rejects(badResult.provider.generateAudio!(request), /媒体地址/);
  const base64Result = await createProvider([{ status: "completed", data: { data: `data:audio/wav;base64,${audioBase64}` } }]);
  const base64Output = await base64Result.provider.generateAudio!(request);
  assert.equal(base64Output[0]?.type, "base64");
  assert.equal(base64Output[0]?.type === "base64" && base64Output[0].data, audioBase64);
  assert.equal(base64Output[0]?.mimeType, "audio/wav");
  const noKey = await loadMediaProviderSource(source, { apiKey: "" });
  await assert.rejects(noKey.generateAudio!(request), /API Key/);

  const controller = new AbortController();
  const canceled = await createProvider([{ status: "pending", data: {} }], controller.signal);
  onWait = () => controller.abort();
  await assert.rejects(canceled.provider.generateAudio!(request), { name: "AbortError" });
  onWait = undefined;
  assert.equal(canceled.calls.length, 2, "取消后不得再次轮询");
  const canceledBeforeStart = new AbortController();
  canceledBeforeStart.abort();
  await assert.rejects(createProvider([], canceledBeforeStart.signal), { name: "AbortError" });
  const inFlightController = new AbortController();
  let inFlightRequests = 0;
  const stalledFetch = Object.assign((_input: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_done, reject) => {
    inFlightRequests++;
    assert.ok(init?.signal);
    init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    queueMicrotask(() => inFlightController.abort());
  }), { preconnect: originalFetch.preconnect }) as typeof fetch;
  const inFlight = await loadMediaProviderSource(source, { apiKey: "mockKey" }, inFlightController.signal, stalledFetch);
  await assert.rejects(inFlight.generateAudio!(request), { name: "AbortError" });
  assert.equal(inFlightRequests, 1, "取消正在发送的创建请求后不得轮询");

  for (const mediaType of ["image", "video"] as const) {
    const regression = await createProvider([{ status: "completed", data: { data: `https://mock.invalid/result.${mediaType === "image" ? "png" : "mp4"}` } }]);
    if (mediaType === "image") await regression.provider.generateImage!({ model: "seedream", prompt: "图片" });
    else await regression.provider.generateVideo!({ model: "seedance", prompt: "视频" });
    assert.deepEqual(regression.calls.map(call => call.path), mediaType === "image"
      ? ["/v1/image/generateImage", "/v1/image/getImageStatus"]
      : ["/v1/video/generateVideo", "/v1/video/getVideoStatus"]);
  }
  console.log("Linke 音频检查通过：真实适配器加载、文本与全部参考媒体格式、采样率/编码/语速/音量/音调、轮询与失败/取消、图片视频回归；真实网络请求 0 次。");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (originalDataDirectory === undefined) delete process.env.TOONFLOW_DATA_DIR;
  else process.env.TOONFLOW_DATA_DIR = originalDataDirectory;
  assert.ok(resolve(temporaryDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowJinyuDreamAudio`));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
// ACT: 宿主配置会启动文件监听；完成临时目录清理后退出单次检查。
process.exit(0);
