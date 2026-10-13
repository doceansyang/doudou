import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 判断「我们抓回的成片」里有没有水印 —— 用**官方原片当参照物做 A/B 差分**，
 * 而不是去认水印长什么样。
 *
 * 为什么用这个思路（2026-10-13 定案，别再退回"检测水印特征库"那条路）：
 *   · 平台自己的「原片」接口能给到**同一画面的无标记编码**（见 doubao-rpa-core.ts 的 fplay 解析）；
 *   · 同一画面的两种编码之间，差值只是压缩噪声；而**水印只存在于其中一份里**，
 *     相减就会单独暴露成一小块实心区域。实测分离度：
 *       干净对：强差像素外接框**铺满全画面（62%~100%）**、框内填充率 0.00~0.04；
 *       水印对：外接框只占画面 **0.11%**（57x17 的一小块）、填充率 **0.28~0.41**。
 *     三个量都差 7~27 倍，门槛取在中间，余量很大。
 *   · 对比过 CDTV 的「角落水印检测器」：它在**明显的合成文字水印上不报警**，
 *     却在**干净的花布画面**上误报 —— 假阴假阳都占，不能当判据（已实测）。
 *
 * 判定之后的动作也是安全的：
 *   · 判为有水印 → 换成**官方原片**（无损，不是抹像素）；
 *   · 判为没有   → 原样保留我们抓到的成片（不做任何重编码，避免降质）。
 *   两个方向都不会把成片弄坏，所以这个判据即使将来遇到没见过的水印样式，也不会误伤。
 */

export type WatermarkVerdict = {
  /** 是否判定"我们抓回的这份带水印"。 */
  watermarked: boolean;
  /** 强差像素占全画面的百分比。 */
  strongRatio: number;
  /** 强差像素外接框占全画面的百分比（水印应该是个小区域）。 */
  bboxAreaPct: number;
  /** 强差像素在其外接框内的填充率（水印是实心块，编码噪声是零散的）。 */
  fill: number;
  /** 外接框（原分辨率像素），没有强差像素时为 null。 */
  box: { x: number; y: number; width: number; height: number } | null;
  frames: number;
  width: number;
  height: number;
  /** 一句话结论，直接进日志。 */
  reason: string;
};

/** 逐像素灰度差超过它就记作"强差"（30 能覆盖较淡的半透明白字，实测分离度仍很大）。 */
const STRONG_DIFF = 30;
/** 强差像素至少占画面这个比例（%），否则视为只是编码噪声。 */
const MIN_STRONG_RATIO = 0.02;
/** 强差外接框不得超过画面这个比例（%）：水印是一小块，整画面差异说明是"两种编码"而非水印。 */
const MAX_BBOX_AREA_PCT = 3;
/** 强差像素在外接框内的填充率下限：实心块 >= 0.15，零散噪声约 0.00~0.04。 */
const MIN_FILL = 0.15;

/** 找 ffmpeg：优先环境变量，其次当前实例目录（RPA 服务就装在应用目录里），
 *  再退到安装版固定位置（方便在仓库开发态直接跑），最后交给 PATH。 */
export function resolveFfmpeg(): string {
  const override = process.env.DOUBAO_FFMPEG;
  if (override && existsSync(override)) return override;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    resolve(process.cwd(), "data", "ffmpeg", "win32-x64", "ffmpeg.exe"),
    resolve(process.cwd(), "data", "ffmpeg", "ffmpeg.exe"),
    localAppData && resolve(localAppData, "Programs", "JinyuTV", "data", "ffmpeg", "win32-x64", "ffmpeg.exe"),
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? "ffmpeg";
}

/** 读视频尺寸与帧数（ffprobe 与 ffmpeg 同目录）。 */
function probe(file: string, ffmpegPath: string): Promise<{ width: number; height: number; frames: number }> {
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", file],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("error", reject);
    child.on("close", () => {
      const [width, height, frames] = out.trim().split("\n")[0].split(",");
      const parsed = { width: Number(width), height: Number(height), frames: Number(frames) || 0 };
      if (!parsed.width || !parsed.height) reject(new Error(`读不出视频尺寸：${out.trim().slice(0, 120)}`));
      else resolvePromise(parsed);
    });
  });
}

/**
 * 两份视频逐像素求灰度差，并保留**逐像素的时间最大值**，再按三个量判定。
 *
 * 用 ffmpeg 的 `blend=difference` 直接出差分流，我们只 keep 一个 921KB 的 running max，
 * 不把整段差分留在内存里（10 秒 720p 也就 240MB 原始差分，没必要）。
 */
export async function compareForWatermark(
  watermarkedPath: string,
  originalPath: string,
  ffmpegPath = resolveFfmpeg(),
): Promise<WatermarkVerdict> {
  const { width, height, frames } = await probe(watermarkedPath, ffmpegPath);
  const pixels = width * height;
  const peak = new Uint8Array(pixels);
  let seen = 0;

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-v", "error",
        "-i", watermarkedPath,
        "-i", originalPath,
        "-filter_complex", "[0:v][1:v]blend=all_mode=difference:shortest=1,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ],
      { windowsHide: true },
    );
    let pending = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= pixels) {
        const frame = pending.subarray(0, pixels);
        pending = pending.subarray(pixels);
        for (let index = 0; index < pixels; index += 1) {
          if (frame[index] > peak[index]) peak[index] = frame[index];
        }
        seen += 1;
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !seen) reject(new Error(`差分失败（ffmpeg 退出码 ${code}）：${stderr.slice(0, 200)}`));
      else resolvePromise();
    });
  });

  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (peak[row + x] > STRONG_DIFF) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const strongRatio = (count / pixels) * 100;
  const boxWidth = count ? maxX - minX + 1 : 0;
  const boxHeight = count ? maxY - minY + 1 : 0;
  const boxPixels = boxWidth * boxHeight;
  const bboxAreaPct = (boxPixels / pixels) * 100;
  const fill = boxPixels ? count / boxPixels : 0;

  const watermarked =
    strongRatio >= MIN_STRONG_RATIO && bboxAreaPct <= MAX_BBOX_AREA_PCT && fill >= MIN_FILL;

  const detail =
    `强差占比 ${strongRatio.toFixed(4)}%（门槛 ${MIN_STRONG_RATIO}）｜` +
    `外接框占画面 ${bboxAreaPct.toFixed(3)}%（上限 ${MAX_BBOX_AREA_PCT}）｜` +
    `框内填充率 ${fill.toFixed(2)}（下限 ${MIN_FILL}）`;
  const reason = count
    ? `${watermarked ? "判定有水印" : "判定无水印"}：${detail}`
    : `判定无水印：全片逐像素差都不超过 ${STRONG_DIFF}（两份是同一画面）`;

  return {
    watermarked,
    strongRatio,
    bboxAreaPct,
    fill,
    box: count ? { x: minX, y: minY, width: boxWidth, height: boxHeight } : null,
    frames: seen || frames,
    width,
    height,
    reason,
  };
}
