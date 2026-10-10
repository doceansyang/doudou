// 运行：bun packages/nodes/videoNode/scripts/checkVideoProcessing.ts，需要 PATH 中的 ffmpeg 和 ffprobe。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { createFfmpeg } from "@toonflow/ffmpeg/runtime";
import type { BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import { processVideo } from "../src/videoProcessing";

const ffmpegPath = Bun.which("ffmpeg");
assert.ok(ffmpegPath && Bun.which("ffprobe"), "请先把 ffmpeg 和 ffprobe 加入 PATH");
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "toonflowVideoProcessing-"));
const nativeFfmpeg = createFfmpeg(directory);
const ffmpeg = nativeFfmpeg as unknown as BrowserFfmpegFactory;

async function execute(args: string[]) {
  const child = Bun.spawn([ffmpegPath!, "-hide_banner", "-loglevel", "error", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr);
  return new Uint8Array(stdout);
}

function probe(path: string) {
  return new Promise<FfprobeData>((resolve, reject) => nativeFfmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(data)));
}

async function colorAt(path: string, time: number) {
  const pixel = await execute(["-ss", String(time), "-i", join(directory, path), "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(pixel.length, 3);
  return pixel[0]! > pixel[2]! ? "red" : "blue";
}

try {
  await execute(["-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=2", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-c:a", "aac", join(directory, "source.mp4")]);
  const sourceHash = createHash("sha256").update(new Uint8Array(await file(join(directory, "source.mp4")).arrayBuffer())).digest("hex");
  const audio = await processVideo(ffmpeg, "source.mp4", { action: "extractAudio", audioPath: "audio.m4a" });
  const audioProbe = await probe("audio.m4a");
  assert.deepEqual(audioProbe.streams.map(stream => stream.codec_type), ["audio"]);
  assert.equal(audioProbe.streams[0]?.codec_name, "aac");
  assert.ok(Math.abs(audio.duration - 4) < 0.1);

  await processVideo(ffmpeg, "source.mp4", { action: "separate", audioPath: "separate.m4a", videoPath: "silent.mp4" });
  assert.deepEqual((await probe("silent.mp4")).streams.map(stream => stream.codec_type), ["video"]);
  assert.deepEqual((await probe("separate.m4a")).streams.map(stream => stream.codec_type), ["audio"]);
  assert.equal(await colorAt("silent.mp4", 2.5), "blue");

  const trimmed = await processVideo(ffmpeg, "source.mp4", { action: "trim", videoPath: "trim.mp4", start: 1.4, end: 2.6 });
  assert.ok(Math.abs(trimmed.duration - 1.2) < 0.05, `截取时长 ${trimmed.duration}`);
  assert.equal(trimmed.width, 160);
  assert.equal(trimmed.height, 90);
  assert.deepEqual((await probe("trim.mp4")).streams.map(stream => stream.codec_type), ["video", "audio"]);
  assert.equal(await colorAt("trim.mp4", 0.4), "red", "截取前半段必须来自红色片段");
  assert.equal(await colorAt("trim.mp4", 0.8), "blue", "截取后半段必须来自蓝色片段");
  await processVideo(ffmpeg, "silent.mp4", { action: "trim", videoPath: "silentTrim.mp4", start: 0.3, end: 1.1 });
  assert.deepEqual((await probe("silentTrim.mp4")).streams.map(stream => stream.codec_type), ["video"]);

  for (const action of ["extractAudio", "separate"] as const) {
    await assert.rejects(processVideo(ffmpeg, "silent.mp4", { action, audioPath: "invalid.m4a", videoPath: "invalid.mp4" }), /没有音轨/);
  }
  for (const [start, end] of [[-1, 2], [0, 5], [2, 2], [2, 1], [NaN, 2], [0, Infinity]]) {
    await assert.rejects(processVideo(ffmpeg, "source.mp4", { action: "trim", videoPath: "invalid.mp4", start, end }), /截取范围/);
  }
  await assert.rejects(processVideo(ffmpeg, "source.mp4", { action: "trim", videoPath: "./source.mp4", start: 0, end: 1 }), /覆盖/);
  await assert.rejects(processVideo(ffmpeg, "source.mp4", { action: "separate", audioPath: "same.mp4", videoPath: "same.mp4" }), /覆盖/);
  await assert.rejects(processVideo(ffmpeg, "source.mp4", { action: "trim", videoPath: "../outside.mp4", start: 0, end: 1 }), /相对路径/);
  await assert.rejects(processVideo(ffmpeg, "source.mp4", { action: "trim", videoPath: "invalid.mp4", start: 0, end: 1 }, AbortSignal.abort()), { name: "AbortError" });
  const controller = new AbortController();
  const cancellingFfmpeg = ((...args: Parameters<BrowserFfmpegFactory>) => {
    const command = Reflect.apply(ffmpeg, undefined, args);
    command.on("start", () => controller.abort());
    return command;
  }) as BrowserFfmpegFactory;
  await assert.rejects(processVideo(cancellingFfmpeg, "source.mp4", { action: "trim", videoPath: "cancelled.mp4", start: 0, end: 4 }, controller.signal), { name: "AbortError" });
  assert.equal(await file(join(directory, "invalid.mp4")).exists(), false);
  assert.equal(await file(join(directory, "invalid.m4a")).exists(), false);
  assert.equal(createHash("sha256").update(new Uint8Array(await file(join(directory, "source.mp4")).arrayBuffer())).digest("hex"), sourceHash);
  console.log("videoProcessing OK: AAC 音轨、静音分离、非关键帧精确截取、无音轨截取、非法输入、取消和原视频保护");
} finally {
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  await rm(directory, { recursive: true, force: true });
}
