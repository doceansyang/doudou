# -*- coding: utf-8 -*-
"""去除豆包「AI生成」角标水印（半透明白字、会在画面里跳动）。

======================================================================
为什么是这个做法（一路实测淘汰下来的，别轻易换回去）
======================================================================
豆包的水印**不是固定角标**：实测它会在「左上」「右下」等位置之间来回跳，
而且是**半透明白字**（背景纹理能透过来）。2026-10-13 针对真实样本逐一试过：

  ✗ 换平台原片      —— 平台侧只有**一个**带水印的文件：get_play_info 的
                       media_info 与 original_media_info 是同一 URL，
                       删/改 lr 参数后下载 SHA 完全相同（逐像素一致）。
  ✗ 时序背景重建    —— 水印在某位置停留时间过长时，低分位背景本身就带水印；
                       且画面在动，重建出的背景与当前帧对不上（条状拖影）。
  ✗ 颜色/亮度阈值   —— 画面里本来就有大片白色被褥、白墙，与半透明白字分不开。
  ✗ CDTV 角落检测器 —— 对明显的合成白字**不报警**、对干净花布**误报**，不可用。
  ✓ **局部对比 + 细结构 + inpaint** —— 就是本脚本：
      掩码 = luma - GaussianBlur(luma, sigma=9) 超过阈值（细笔画会显著高于周边
      大尺度背景，而**大块白被褥因尺度大、被一起带平，反差反而小**）；
      再对掩码做 Telea + NS 两种 inpaint 融合。

======================================================================
用法
======================================================================
  python scripts/deshadow-doubao.py <输入.mp4> <输出.mp4>
  python scripts/deshadow-doubao.py <in> <out> --boxes "x0,y0,x1,y1;..."   # 覆盖水印框

⚠️ 默认框是 960x720 竖版实测标定的（左上 + 右下）。换分辨率/换平台版本后
   **必须重新标定**：先跑 `scripts/check-watermark.py` 或直接用
  `--dump-mask` 看掩码是否落在文字上，再定框。框只覆盖水印本身及其活动范围，
   别图省事放大到整屏 —— 框内非文字内容也会被 inpaint 抹掉。
"""
import argparse
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)

# 960x720 实测标定：水印在两个位置之间跳，框要覆盖它的活动范围。
DEFAULT_BOXES = [
    (20, 20, 205, 70),      # 左上
    (807, 661, 941, 691),   # 右下
]


def probe(video: Path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames,r_frame_rate", "-of", "json", str(video)],
        capture_output=True, text=True, check=True).stdout
    stream = json.loads(out)["streams"][0]
    return (int(stream["width"]), int(stream["height"]),
            int(stream.get("nb_frames") or 0), stream["r_frame_rate"])


def main():
    parser = argparse.ArgumentParser(description="去除豆包 AI 生成角标水印")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--boxes", help="x0,y0,x1,y1;...（留空用内置实测框）")
    parser.add_argument("--contrast", type=float, default=22.0,
                        help="局部对比阈值：越高越保守（越不容易误伤画面）")
    parser.add_argument("--min-px", type=int, default=40, help="框内掩码下限（低于视为该帧无水印）")
    parser.add_argument("--max-px", type=int, default=8000, help="框内掩码上限（高于视为框没对准，跳过）")
    parser.add_argument("--dilate", type=int, default=2, help="掩码膨胀，覆盖抗锯齿边缘")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--dump-mask", type=Path, help="把某一帧的掩码叠加图导出，用于核对框是否对准")
    parser.add_argument("--dump-frame", type=int, default=0, help="--dump-mask 用哪一帧")
    args = parser.parse_args()

    boxes = ([tuple(int(v) for v in chunk.split(",")) for chunk in args.boxes.split(";")]
             if args.boxes else DEFAULT_BOXES)
    video = args.input.resolve()
    width, height, count, rate = probe(video)
    print("输入 %s  %dx%d  %d 帧" % (video.name, width, height, count))
    for box in boxes:
        print("  水印框 %s（%dx%d）" % (box, box[2] - box[0], box[3] - box[1]))

    decoder = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(video), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    partial = args.output.with_name(args.output.stem + ".processing" + args.output.suffix)
    encoder = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-video_size", "%dx%d" % (width, height), "-framerate", rate, "-i", "pipe:0",
         "-i", str(video), "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "1",
         "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
         "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(partial)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    frame_size = width * height * 3
    kernel = np.ones((3, 3), np.uint8)
    processed = fixed = skipped = 0
    assert decoder.stdout is not None and encoder.stdin is not None
    while True:
        raw = decoder.stdout.read(frame_size)
        if not raw or len(raw) < frame_size:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
        gray = frame.astype(np.float32) @ LUMA
        contrast = gray - cv2.GaussianBlur(gray, (0, 0), 9)
        for box in boxes:
            x0, y0, x1, y1 = box
            mask = (contrast[y0:y1, x0:x1] > args.contrast).astype(np.uint8)
            pixels = int(mask.sum())
            if pixels < args.min_px:
                continue
            if pixels > args.max_px:
                skipped += 1
                continue
            if args.dump_mask and processed == args.dump_frame:
                vis = frame.copy()
                area = vis[y0:y1, x0:x1]
                area[mask > 0] = (0, 255, 0)
                args.dump_mask.parent.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(args.dump_mask), cv2.cvtColor(vis, cv2.COLOR_RGB2BGR))
                print("  掩码叠加图已导出：%s（绿色=将被修复的像素）" % args.dump_mask)
            mask = cv2.dilate(mask, kernel, iterations=args.dilate)
            patch = frame[y0:y1, x0:x1]
            telea = cv2.inpaint(patch, mask, 3, cv2.INPAINT_TELEA)
            ns = cv2.inpaint(patch, mask, 3, cv2.INPAINT_NS)
            frame[y0:y1, x0:x1] = np.clip(
                telea.astype(np.float32) * 0.6 + ns.astype(np.float32) * 0.4, 0, 255).astype(np.uint8)
            fixed += 1
        encoder.stdin.write(frame.tobytes())
        processed += 1
    encoder.stdin.close()
    error = encoder.stderr.read().decode(errors="replace") if encoder.stderr else ""
    decoder.kill()
    if encoder.wait():
        partial.unlink(missing_ok=True)
        raise SystemExit("编码失败：" + error.strip())
    partial.replace(args.output)
    print("  修复 %d 处，跳过 %d 处（掩码异常），共 %d 帧" % (fixed, skipped, processed))
    print("完成：%s" % args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
