// 运行：bun packages/nodes/audioNode/scripts/checkAudioProcessing.ts，需要 PATH 中的 ffmpeg 和 ffprobe。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { createFfmpeg } from "@toonflow/ffmpeg/runtime";
import type { BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import { processAudio } from "../src/audioProcessing";

const ffmpegPath = Bun.which("ffmpeg");
assert.ok(ffmpegPath && Bun.which("ffprobe"), "请先把 ffmpeg 和 ffprobe 加入 PATH");
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "toonflowAudioProcessing-"));
const nativeFfmpeg = createFfmpeg(directory);
const ffmpeg = nativeFfmpeg as unknown as BrowserFfmpegFactory;

async function execute(args: string[]) {
  const child = Bun.spawn([ffmpegPath!, "-hide_banner", "-loglevel", "error", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr);
  return stdout;
}

function probe(path: string) {
  return new Promise<FfprobeData>((resolve, reject) => nativeFfmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(data)));
}

async function assertFrequency(path: string, start: number, expected: number) {
  const samples = new Float32Array(await execute(["-ss", String(start), "-i", join(directory, path), "-t", "0.12",
    "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]));
  assert.ok(samples.length > 1500, "必须解码出实际音频采样");
  let crossings = 0;
  for (let index = 1; index < samples.length; index++) if (samples[index - 1]! <= 0 && samples[index]! > 0) crossings++;
  const frequency = crossings * 16000 / samples.length;
  assert.ok(Math.abs(frequency - expected) < 15, `${path} 在 ${start}s 的频率为 ${frequency}Hz，预期 ${expected}Hz`);
}

async function sourceHash() {
  return createHash("sha256").update(new Uint8Array(await file(join(directory, "source.m4a")).arrayBuffer())).digest("hex");
}

try {
  // 第一轨依次为 440/660/880 Hz，第二轨 1200 Hz 用来检查始终选取第一轨。
  await execute(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-f", "lavfi", "-i", "sine=frequency=1200:duration=3.01",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[joined]", "-map", "[joined]", "-map", "3:a", "-c:a", "aac", "-b:a", "192k", join(directory, "source.m4a")]);
  const originalHash = await sourceHash();
  const speedDurations: Record<string, number> = {};
  for (const speed of [0.1, 2, 4]) {
    const outputPath = `speed${speed}.m4a`;
    const result = await processAudio(ffmpeg, "source.m4a", { action: "speed", speed, outputPath });
    const expectedDuration = 3 / speed;
    // atempo 按窗口重叠处理，结尾有少量采样误差；允许 3% 或 0.12s 的原生精度。
    assert.ok(Math.abs(result.duration - expectedDuration) < Math.max(0.12, expectedDuration * 0.03), `${speed} 倍实际时长 ${result.duration}s`);
    assert.deepEqual((await probe(outputPath)).streams.map(stream => [stream.codec_type, stream.codec_name]), [["audio", "aac"]]);
    await assertFrequency(outputPath, 0.05, 440);
    speedDurations[speed] = result.duration;
  }

  const clipped = await processAudio(ffmpeg, "source.m4a", { action: "clip", outputPath: "clipped.m4a", segments: [
    { start: 2.2, end: 2.7 }, { start: 0.2, end: 0.8 }, { start: 2.2, end: 2.7 }, { start: 1.1, end: 1.5 },
  ] });
  assert.ok(Math.abs(clipped.duration - 2) < 0.05, `拼接后的实际时长 ${clipped.duration}s`);
  for (const [time, frequency] of [[0.15, 880], [0.65, 440], [1.25, 880], [1.75, 660]]) await assertFrequency("clipped.m4a", time!, frequency!);
  await processAudio(ffmpeg, "source.m4a", { action: "clip", outputPath: "single.m4a", segments: [{ start: 1.1, end: 1.5 }] });
  await assertFrequency("single.m4a", 0.1, 660);
  const sourceMetadata = await probe("source.m4a");
  assert.ok(Number(sourceMetadata.format.duration) > Number(sourceMetadata.streams[0]?.duration), "覆盖容器时长略长于第一音轨");
  const fullClip = await processAudio(ffmpeg, "source.m4a", { action: "clip", outputPath: "full.m4a", segments: [{ start: 0, end: Number(sourceMetadata.format.duration) }] });
  assert.ok(Math.abs(fullClip.duration - 3) < 0.05, "容器和音轨时长差异不能阻止全长截取");

  for (const speed of [0, 0.09, 4.01, NaN, Infinity]) {
    await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "speed", speed, outputPath: "invalid.m4a" }), /速度/);
  }
  await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "clip", segments: [], outputPath: "invalid.m4a" }), /片段/);
  for (const [start, end] of [[-1, 2], [0, 4], [2, 2], [2, 1], [NaN, 2], [0, Infinity]]) {
    await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "clip", segments: [{ start: start!, end: end! }], outputPath: "invalid.m4a" }), /片段/);
  }
  await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "speed", speed: 1, outputPath: "./source.m4a" }), /覆盖/);
  await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "speed", speed: 1, outputPath: "../outside.m4a" }), /相对路径/);
  await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "speed", speed: 1, outputPath: "." }), /路径不能为空/);
  await execute(["-f", "lavfi", "-i", "color=black:s=16x16:d=0.2", "-an", "-c:v", "libx264", join(directory, "noAudio.mp4")]);
  await assert.rejects(processAudio(ffmpeg, "noAudio.mp4", { action: "speed", speed: 1, outputPath: "invalid.m4a" }), /不包含音轨/);
  await assert.rejects(processAudio(ffmpeg, "source.m4a", { action: "speed", speed: 1, outputPath: "invalid.m4a" }, AbortSignal.abort()), { name: "AbortError" });
  const controller = new AbortController();
  const cancellingFfmpeg = ((...args: Parameters<BrowserFfmpegFactory>) => {
    const command = Reflect.apply(ffmpeg, undefined, args);
    command.on("start", () => controller.abort());
    return command;
  }) as BrowserFfmpegFactory;
  await assert.rejects(processAudio(cancellingFfmpeg, "source.m4a", { action: "speed", speed: 0.1, outputPath: "cancelled.m4a" }, controller.signal), { name: "AbortError" });
  assert.equal(await file(join(directory, "invalid.m4a")).exists(), false);
  assert.equal(await sourceHash(), originalHash, "原音频必须保持不变");
  console.log("audioProcessing OK: 0.1/2/4 倍保音高、第一音轨、重复及逆序片段、非法范围、取消和源保护", speedDurations);
} finally {
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  await rm(directory, { recursive: true, force: true });
}
