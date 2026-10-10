// 运行：bun run --cwd apps/server ../../packages/nodes/audioGenerationNode/scripts/checkAudioRequest.ts；仅使用临时供应商和本地 HTTP。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { useNodeAi } from "../../../nodeScaffold/src/nodeAi";

const require = createRequire(new URL("../../../../apps/server/package.json", import.meta.url));
const nodeRequire = createRequire(new URL("../../../nodeScaffold/package.json", import.meta.url));
const { effectScope } = await import(nodeRequire.resolve("vue"));
const { mkdir, mkdtemp, readFile, rm, writeFile } = await import(require.resolve("@toonflow/file"));
const { default: express } = await import(require.resolve("express"));
const { audioGenerationSchema } = await import(require.resolve("@toonflow/tool-media-generation/runtime"));
const testDirectory = await mkdtemp(join(tmpdir(), "toonflowAudioRequest"));
process.env.TOONFLOW_DATA_DIR = testDirectory;
const directory = join(testDirectory, "workspaces", "check");
const wave = Buffer.alloc(46);
const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
wave.write("RIFF"); wave.writeUInt32LE(38, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(2, 40);
await mkdir(directory, { recursive: true });
await mkdir(join(testDirectory, "providers"));
await writeFile(join(directory, "reference.wav"), wave);
await writeFile(join(directory, "reference.png"), png);
await writeFile(join(testDirectory, "providers", "checkAudio.ts"), `export default {
  id: "checkAudio", label: "本地检查", rules: [],
  models: [{ id: "audio", label: "音频", type: "audio", voices: [{ title: "测试", voice: "voice" }] }, { id: "pcm", label: "PCM", type: "audio" }, { id: "image", label: "图片", type: "image" }],
  async generateAudio(request) {
    if (request.model === "pcm") return [{ type: "url", mediaType: "audio", mimeType: "audio/pcm", url: request.voice }];
    const expected = { model: "audio", text: "测试音频", voice: "voice", speed: 1, volume: 0, pitch: 12, language: "en", format: "wav", sampleRate: 24000 };
    for (const [key, value] of Object.entries(expected)) if (request[key] !== value) throw new Error("字段未贯通：" + key);
    if (request.audios?.length !== 1 || request.audios[0].mimeType !== "audio/wav" || request.audios[0].type !== "base64") throw new Error("参考音频未贯通");
    if (request.images?.length !== 1 || request.images[0].mimeType !== "image/png" || request.images[0].type !== "base64" || request.images[0].data !== ${JSON.stringify(png.toString("base64"))}) throw new Error("参考图片未贯通");
    return [{ type: "binary", mediaType: "audio", mimeType: "audio/wav", data: new Uint8Array(${JSON.stringify([...wave])}) }];
  }
};`);
const [{ default: generationRoute }, { default: modelsRoute }] = await Promise.all([
  import("../../../../apps/server/src/routes/ai/media/generate"),
  import("../../../../apps/server/src/routes/ai/media/models"),
]);
const app = express();
app.use(express.json());
app.get("/pcm", (_request, response) => { response.setHeader("Content-Type", "Application/Octet-Stream; charset=binary"); response.end(pcm); });
app.get("/pcmWithoutType", (_request, response) => response.end(pcm));
app.get("/pcmInvalidType", (_request, response) => { response.setHeader("Content-Type", "application/json"); response.end(pcm); });
app.use("/api/ai/media/generate", generationRoute);
app.use("/api/ai/media/models", modelsRoute);
app.use((error: Error & { status?: number }, _request: unknown, response: { status(code: number): { json(value: unknown): unknown } }, _next: unknown) => {
  response.status(error.status ?? 500).json({ code: error.status ?? 500, message: error.message });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(done => server.once("listening", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const fetchRequest = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  assert.equal(typeof input, "string");
  const url = new URL(input as string, baseUrl);
  assert.equal(url.origin, baseUrl, "检查不能访问真实供应商");
  return fetchRequest(url, init);
}, { preconnect: fetchRequest.preconnect }) as typeof fetch;
const scope = effectScope();
const ai = scope.run(useNodeAi)!;
const request = {
  directory, providerId: "checkAudio", modelId: "audio", prompt: "测试音频", outputDirectory: "assets/check",
  images: [{ path: "reference.png", mimeType: "image/png" }],
  audios: [{ path: "reference.wav", mimeType: "audio/wav" }], voice: "voice", speed: 1, volume: 0, pitch: 12,
  language: "en", format: "wav", sampleRate: 24000,
};
try {
  for (const pitch of [NaN, Infinity, -Infinity]) {
    assert.equal(audioGenerationSchema.safeParse({ providerId: request.providerId, modelId: request.modelId, prompt: request.prompt, pitch }).success, false);
  }
  const models = await ai.getMediaModels();
  assert.deepEqual(models.filter(model => model.type === "audio").map(model => model.modelId), ["audio", "pcm"]);
  const [result] = await ai.generateAudio(request);
  assert.equal(result?.mediaType, "audio");
  assert.equal(result.mimeType, "audio/wav");
  assert.ok(result.path.startsWith("assets/check/audio"));
  assert.deepEqual(await readFile(join(directory, result.path)), wave);
  for (const path of ["pcm", "pcmWithoutType"]) {
    const [result] = await ai.generateAudio({ ...request, modelId: "pcm", format: "pcm", voice: `${baseUrl}/${path}` });
    assert.equal(result?.mimeType, "audio/pcm");
    assert.ok(result.path.endsWith(".pcm"));
    assert.deepEqual(await readFile(join(directory, result.path)), pcm);
  }
  await assert.rejects(ai.generateAudio({ ...request, modelId: "pcm", format: "pcm", voice: `${baseUrl}/pcmInvalidType` }));
  for (const invalid of [{ language: 1 }, { sampleRate: 0 }, { pitch: "12" }, { pitch: null }, { audios: [{ path: "../reference.wav", mimeType: "audio/wav" }] }, { images: [{ path: "reference.png", mimeType: "audio/wav" }] }, { images: [{ path: "reference.wav", mimeType: "image/png" }] }, { images: [{ path: "../reference.png", mimeType: "image/png" }] }, { modelId: "image" }]) {
    const response = await fetch("/api/ai/media/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, ...invalid, mediaType: "audio" }) });
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ai.generateAudio(request, controller.signal), { name: "AbortError" });
  console.log("音频共享链路检查通过：模型列表、文本/参考图片/参考音频/音调/语种/采样率/格式、WAV 与无特定 Content-Type 的 URL PCM 输出保存、参数校验和取消；真实供应商请求 0 次。");
} finally {
  scope.stop();
  globalThis.fetch = fetchRequest;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  assert.ok(resolve(testDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowAudioRequest`));
  await rm(testDirectory, { recursive: true, force: true });
}
// ACT: 真实宿主配置会开启文件监听；单次检查完成清理后退出，避免 watcher 持续占用进程。
process.exit(0);
