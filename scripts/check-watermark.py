# -*- coding: utf-8 -*-
"""检查一段成片里有没有豆包的「动态角落水印」，并把最明显那一帧放大存出来看。

检测与重建算法复用 CDTV 的 `scripts/watermark_removal.py`（已 vendor 到同目录，
500 行、只依赖 numpy + PIL）。本脚本只做**判读**，不改视频。

为什么需要它
------------
豆包成片的水印是**渐隐的动态角标**：只在部分时段变亮，抽查几帧很容易漏看
（实测：抽样 3 帧全部"看不到"，但逐帧分析在右下角检出 [1240,652,1280,675]）。
所以要靠 `activity`（逐帧水印强度）来定位，而不是靠肉眼抽帧。

用法
----
  python scripts/check-watermark.py <视频文件>
  python scripts/check-watermark.py --latest            # 自动挑最新的豆包成片
  python scripts/check-watermark.py <视频> --dump 目录   # 另存放大对比图

退出码：0 = 没检测到水印；2 = 检测到水印；1 = 出错。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import watermark_removal as wr  # noqa: E402

# 我们的发行版自带 ffmpeg，但不在 PATH 上；这里补上，免得每次都要手配环境。
FFMPEG_CANDIDATES = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/JinyuTV/data/ffmpeg/win32-x64",
    Path("C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable/data/ffmpeg/win32-x64"),
]
SAMPLES = [
    Path("C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/assets/generated"),
]


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    for directory in FFMPEG_CANDIDATES:
        if (directory / "ffmpeg.exe").is_file():
            os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
            return


def latest_video() -> Path:
    found: list[Path] = []
    for directory in SAMPLES:
        if directory.is_dir():
            found += [item for item in directory.glob("*.mp4") if "去水印" not in item.name]
    if not found:
        raise SystemExit("没有找到候选成片，请显式传视频路径")
    return max(found, key=lambda item: item.stat().st_mtime)


def grab_frame(video: Path, index: int, info: "wr.VideoInfo") -> np.ndarray:
    """取第 index 帧（走 ffmpeg 单帧输出，避免整段解码）。"""
    stamp = index / max(info.fps, 1e-6)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", "%.3f" % stamp, "-i", str(video),
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    frame_size = info.width * info.height * 3
    if len(raw) < frame_size:
        raise SystemExit("抽帧失败（拿到 %d 字节，期望 %d）" % (len(raw), frame_size))
    return np.frombuffer(raw[:frame_size], dtype=np.uint8).reshape(info.height, info.width, 3).copy()


def dump_region(video: Path, info: "wr.VideoInfo", region: "wr.WatermarkRegion", directory: Path) -> list[Path]:
    """把水印最强的一帧按原样 / 去水印后 各放大存一张，便于肉眼确认。"""
    peak = int(np.argmax(region.activity))
    frame = grab_frame(video, peak, info)
    x0, y0, x1, y1 = region.box

    # 合成必须在**与水印掩膜同尺寸**的原框上做（background/soft_mask 都按这个框给）；
    # 想看清楚再往外扩边显示，扩边只影响展示，不影响像素。
    dirty = frame[y0:y1, x0:x1].copy()
    alpha = region.soft_mask[..., None] * float(region.activity[peak])
    clean = dirty.astype(np.float32) + (region.background.astype(np.float32) - dirty.astype(np.float32)) * alpha
    clean = np.clip(clean, 0, 255).astype(np.uint8)

    pad = 8
    view = []
    for image in (dirty, clean):
        view.append(np.pad(image, ((pad, pad), (pad, pad), (0, 0)), mode="edge"))

    directory.mkdir(parents=True, exist_ok=True)
    stem = "%s_peak%04d" % (video.stem[:40], peak)
    paths = []
    for label, image in zip(("有水印", "去水印后"), view):
        target = directory / ("%s_%s.png" % (stem, label))
        height, width = image.shape[:2]
        Image.fromarray(image).resize((width * 8, height * 8), Image.NEAREST).save(target)
        paths.append(target)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="检查豆包成片里有没有动态角落水印")
    parser.add_argument("video", nargs="?", type=Path, help="视频文件；省略则用 --latest")
    parser.add_argument("--latest", action="store_true", help="自动挑最新的豆包成片")
    parser.add_argument("--dump", type=Path, help="把水印最强帧的放大对比图存到这个目录")
    args = parser.parse_args()

    ensure_ffmpeg()
    if not shutil.which("ffmpeg"):
        print("!! 找不到 ffmpeg，无法分析")
        return 1

    video = args.video or latest_video()
    if not video.is_file():
        print("!! 视频不存在：%s" % video)
        return 1

    print("分析：%s" % video.name)
    info = wr.probe_video(video)
    print("  规格：%dx%d @ %.2f fps，%d 帧" % (info.width, info.height, info.fps, info.frame_count))

    try:
        regions, frame_count = wr.detect_watermarks(video, info)
    except wr.WatermarkNotFound as error:
        print("  结果：**未检测到水印**（%s）" % error)
        return 0

    if not regions:
        print("  结果：**未检测到水印**")
        return 0

    print("  结果：**检测到 %d 处水印**" % len(regions))
    for index, region in enumerate(regions, 1):
        visible = int(np.count_nonzero(region.activity > 0.25))
        peak = int(np.argmax(region.activity))
        print("    第 %d 处  区域 %s（%dx%d px）" % (
            index, region.box, region.box[2] - region.box[0], region.box[3] - region.box[1]))
        print("           可见帧：%d/%d（%.0f%%，阈值 0.25）｜最强在第 %d 帧（强度 %.2f）" % (
            visible, len(region.activity), 100.0 * visible / max(len(region.activity), 1),
            peak, float(region.activity[peak])))
        if args.dump:
            for path in dump_region(video, info, region, args.dump):
                print("           已存：%s" % path)
    return 2


if __name__ == "__main__":
    sys.exit(main())
