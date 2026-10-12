# -*- coding: utf-8 -*-
"""
「生成中遮罩」交付前的图像分析 —— 被 _overlay-preview/verify.mjs 调用。

分两件事，都是**必须看真实像素**才能下的结论：

1. 背景到底动没动。隔 800ms 抓同尺寸两帧，算逐像素差。
   只看"有没有 canvas"是没用的 —— 建了上下文但每帧画同一张图的 bug 照样能骗过它。

2. 文字压在会动的背景上，对比度还够不够。
   ⚠️ 不能在成图上采「文字像素 vs 周围像素」：抗锯齿边缘会给出假的低对比。
   正确做法是 verify.mjs 先把文字 `visibility: hidden` 只截图背景，
   再用文字元素的**真实矩形**去量那块背景的最亮值，反推白字的实际对比度。
"""
import json
import os
import sys

from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_out")
METRICS = os.path.join(OUT, "_gen-metrics.json")


def luminance(rgb):
    def channel(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = rgb[:3]
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast_white(lum):
    hi, lo = max(1.0, lum), min(1.0, lum)
    return (hi + 0.05) / (lo + 0.05)


def motion(a_path, b_path):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return None
    pa, pb = a.load(), b.load()
    w, h = a.size
    total = 0
    changed = 0
    peak = 0
    for y in range(h):
        for x in range(w):
            ca, cb = pa[x, y], pb[x, y]
            d = abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
            total += d
            peak = max(peak, d)
            if d > 12:
                changed += 1
    n = w * h
    return {"size": a.size, "mean": total / (n * 3.0), "ratio": changed / n, "peak": peak}


def contrast(entry):
    im = Image.open(entry["file"]).convert("RGB")
    box = entry["box"]
    # 夹到图内，避免越界
    x0 = max(0, box["x"]); y0 = max(0, box["y"])
    x1 = min(im.width, x0 + box["w"]); y1 = min(im.height, y0 + box["h"])
    px = im.load()
    lums = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            lums.append(luminance(px[x, y]))
    lums.sort()
    q = lambda p: lums[min(len(lums) - 1, int(len(lums) * p))]
    return {
        "box": (x0, y0, x1, y1),
        "max": lums[-1], "p95": q(0.95), "median": q(0.5), "min": lums[0],
        "n": len(lums),
    }


def main():
    if not os.path.exists(METRICS):
        print("找不到 %s —— 先跑 verify.mjs" % METRICS)
        return 1
    m = json.load(open(METRICS, encoding="utf-8"))

    print("=== 背景动画（同尺寸两帧，隔 800ms）===")
    mo = motion(m["motion"]["a"], m["motion"]["b"])
    if not mo:
        print("  两张图尺寸不一致，无法比对")
        return 1
    print("  尺寸=%s  平均像素差=%.2f  峰差=%d  变化像素占比=%.1f%%"
          % (mo["size"], mo["mean"], mo["peak"], mo["ratio"] * 100))
    print("  判定：%s" % ("✅ 背景确实在动" if mo["ratio"] > 0.05 else "❌ 疑似静止"))

    print()
    print("=== 文字对比度（隐藏文字后量其真实背景）===")
    worst = 99.0
    for key in ("sm", "md", "lg"):
        entry = m["contrast"].get(key)
        if not entry:
            continue
        c = contrast(entry)
        r_p95 = contrast_white(c["p95"])
        r_max = contrast_white(c["max"])
        worst = min(worst, r_p95)
        print("  舞台 %-3s 矩形=%s  背景 最亮=%.3f p95=%.3f 中位=%.3f"
              % (key, c["box"], c["max"], c["p95"], c["median"]))
        print("        白字对比度 最坏(p95)=%.2f:1  极端(max)=%.2f:1  %s"
              % (r_p95, r_max, "✅ ≥4.5" if r_p95 >= 4.5 else "⚠️ <4.5"))
    print("  三档里最差 = %.2f:1" % worst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
