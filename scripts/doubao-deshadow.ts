/**
 * 成片「去水印」——生成链路上的一道自动工序。
 *
 * 背景（实测结论，别再走回头路）：
 *  · 豆包「AI生成」是**半透明白字**，会在画面**左上 / 右下之间来回跳**，不是固定角标；
 *  · 平台**不给无水印版**：get_play_info 的 media_info 与 original_media_info 是同一个 URL，
 *    删/改 lr 参数下载 SHA 完全相同 —— 所以"换原片"那条路是死的。
 *  ⇒ 只能做像素修复。实测有效的是 **局部对比取细笔画 + inpaint**（见 deshadow-doubao.py 顶部）。
 *
 * 策略（两级，永不阻断出片）：
 *  ① 若机器上有可用的 Python + OpenCV → 跑 scripts/deshadow-doubao.py（Telea+NS 融合，效果最自然）；
 *  ② 否则回退 ffmpeg 的 delogo（零依赖，随发行版自带，效果稍逊但有水印就是没了）。
 *  两条路都失败 → **保留原始成片**并如实记日志，绝不因为去水印失败而让生成失败。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveFfmpeg } from "./doubao-watermark.ts";

/** 水印位置：960x720 实测标定（覆盖水印的活动范围）。换分辨率必须重新标定。 */
export const WATERMARK_BOXES = "20,20,205,70;807,661,941,691";

export type DeshadowMethod = "inpaint" | "delogo" | "none";

export type DeshadowResult = {
  applied: boolean;
  method: DeshadowMethod;
  detail: string;
};

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((settle) => {
    const child = spawn(command, args, { windowsHide: true, ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: RunResult) => {
      if (done) return;
      done = true;
      settle(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\n超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); finish({ code: null, stdout, stderr: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
  });
}

/** 找可用的 Python：环境变量 → 随发行版内置 → PATH 上的 python / py。
 *  ⚠️ `data/python` 若是 **venv**（我们用 `python -m venv` 建的），解释器在 `Scripts/` 下，
 *  所以两种布局都要试 —— 少了这个，探测永远落空、一路走 delogo 兜底（踩过一次）。 */
function pythonCandidates(): string[] {
  const list: string[] = [];
  const override = process.env.JINYUTV_PYTHON;
  if (override) list.push(override);
  for (const root of ["data", "runtime"]) {
    const base = resolve(process.cwd(), root, "python");
    list.push(resolve(base, "python.exe"));
    list.push(resolve(base, "Scripts", "python.exe"));
  }
  list.push("python");
  list.push("python3");
  return list;
}

async function pickPythonWithCv2(): Promise<string | null> {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes("\\") && !existsSync(candidate)) continue;
    const probe = await run(candidate, ["-c", "import cv2,sys;print(cv2.__version__)"], 20000).catch(() => null);
    if (probe && probe.code === 0 && /\d+\.\d+/.test(probe.stdout)) return candidate;
  }
  return null;
}

/**
 * 对成片做一次去水印。**就地替换** videoPath（原文件先备份为 `.原带水印.mp4`）。
 * 任何一步失败都保持原样，返回 applied=false。
 */
export async function deshadowVideo(
  videoPath: string,
  log: (message: string) => void,
): Promise<DeshadowResult> {
  const output = videoPath.replace(/\.mp4$/i, ".去水印.mp4");
  const backup = videoPath.replace(/\.mp4$/i, ".原带水印.mp4");

  // ① Python + OpenCV：效果最好的那条
  const python = await pickPythonWithCv2();
  if (python) {
    const script = resolve(process.cwd(), "scripts", "deshadow-doubao.py");
    if (existsSync(script)) {
      // ⚠️ ffmpeg 在发行版里位于 data/ffmpeg，**不在 PATH 上**，必须显式传给 Python 侧
      // （否则脚本内部 spawn ffmpeg 会 WinError 2，一路掉回 delogo 兜底 —— 踩过一次）。
      const pyEnv = { ...process.env, DOUBAO_FFMPEG: resolveFfmpeg() };
      const result = await run(
        python,
        [script, videoPath, output, "--boxes", WATERMARK_BOXES],
        600_000,
        pyEnv,
      );
      if (result.code === 0 && existsSync(output)) {
        await copyFile(videoPath, backup).catch(() => undefined);
        await rename(output, videoPath);
        const tail = result.stdout.trim().split("\n").slice(-2).join(" / ");
        return { applied: true, method: "inpaint", detail: tail || "inpaint 完成" };
      }
      await rm(output, { force: true }).catch(() => undefined);
      log(`去水印（inpaint）未成功，改用 delogo 兜底：${(result.stderr || result.stdout).slice(-200)}`);
    } else {
      log(`未找到 ${script}，改用 delogo 兜底`);
    }
  } else {
    log("未找到带 OpenCV 的 Python，改用 delogo 兜底");
  }

  // ② ffmpeg delogo：零依赖兜底
  try {
    const ffmpeg = resolveFfmpeg();
    const filter = WATERMARK_BOXES.split(";")
      .map((box) => {
        const [x0, y0, x1, y1] = box.split(",").map(Number);
        return `delogo=x=${x0}:y=${y0}:w=${x1 - x0}:h=${y1 - y0}`;
      })
      .join(",");
    const result = await run(
      ffmpeg,
      ["-y", "-v", "error", "-i", videoPath, "-vf", filter,
       "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
       "-c:a", "copy", "-movflags", "+faststart", output],
      600_000,
    );
    if (result.code === 0 && existsSync(output)) {
      await copyFile(videoPath, backup).catch(() => undefined);
      await rename(output, videoPath);
      return { applied: true, method: "delogo", detail: "ffmpeg delogo 完成" };
    }
    await rm(output, { force: true }).catch(() => undefined);
    return { applied: false, method: "none", detail: (result.stderr || "delogo 失败").slice(-200) };
  } catch (error) {
    return { applied: false, method: "none", detail: String(error).slice(0, 200) };
  }
}
