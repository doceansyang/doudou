# -*- coding: utf-8 -*-
"""首页「文字 vs 背景」对比度核对（支持毛玻璃等半透明面）。

输入由 _probe-bg-contrast.ts 产出：
  _out/home-bg-only.png     隐藏页头/正文后截到的纯背景图（图里没有文字，采样干净）
  _out/bg-text-boxes.json   每个文字元素：文字色 + 矩形 + 从自身到 .home 的每层背景色/透明度

合成顺序：以背景图上的像素为底，从**最外层**祖先往内逐层按 alpha 叠加，
得到文字真正的有效底色，再算 WCAG 对比度。
用法：python scripts/_check-bg-contrast.py
"""
import json
import sys

from PIL import Image

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/scripts/_out/"


def luminance(color):
    def channel(value):
        v = value / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])


def contrast(fg, bg):
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def over(layer, backdrop):
    """把一层半透明颜色叠到背景上。"""
    r, g, b, alpha = layer
    return tuple(layer[i] * alpha + backdrop[i] * (1 - alpha) for i in range(3))


def effective_background(page_pixel, layers):
    """layers 从元素自身到最外层，叠加时要从最外层开始。"""
    result = page_pixel
    for layer in reversed(layers):
        result = over(layer, result)
    return result


def parse_color(css):
    """解析 CSS 颜色字符串：兼容 rgb()/rgba() 与 color(srgb r g b / a)。"""
    if css == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    body = css[css.find("(") + 1:css.rfind(")")]
    values = []
    for token in body.replace(",", " ").replace("/", " ").split():
        try:
            values.append(float(token))
        except ValueError:
            continue  # 跳过 "srgb" 这类单词（它会让整层解析失败，踩过）
    if len(values) < 3:
        return (0.0, 0.0, 0.0, 0.0)
    alpha = values[3] if len(values) > 3 else 1.0
    if "srgb" in css and not css.startswith("rgb"):
        return (values[0] * 255, values[1] * 255, values[2] * 255, alpha)
    return (values[0], values[1], values[2], alpha)


def main():
    background = Image.open(BASE + "home-bg-only.png").convert("RGB")
    boxes = json.load(open(BASE + "bg-text-boxes.json", encoding="utf-8"))
    width, height = background.size

    rows = []
    for box in boxes:
        parsed = parse_color(box["color"])
        layers = box.get("layers", [])

        # 渐变文字（background-clip:text）的文字色是透明的，真正显色的是渐变色标。
        # 每个色标都是候选前景 → 逐个算并取**最差**：某一瞬间某个色标正好落在亮背景上，
        # 就是用户会看到「有一截字看不清」的时刻。
        gradients = box.get("gradientColors") or []
        if parsed[3] < 0.05 and gradients:
            foregrounds = [tuple(g[:3]) for g in gradients]
            label = "渐变文字（%d 个色标取最差）" % len(foregrounds)
        else:
            foregrounds = [parsed[:3]]
            label = box["color"]

        worst = None
        # 在元素矩形内稀疏取样：关心的是「最亮的那一处」（最容易压不住文字的位置）
        step_x = max(2, box["w"] // 12)
        step_y = max(2, box["h"] // 4)
        for y in range(max(0, box["y"]), min(height - 1, box["y"] + box["h"]) + 1, step_y):
            for x in range(max(0, box["x"]), min(width - 1, box["x"] + box["w"]) + 1, step_x):
                page_pixel = background.getpixel((x, y))
                bg = effective_background(page_pixel, layers)
                for fg in foregrounds:
                    value = contrast(fg, bg)
                    if worst is None or value < worst[0]:
                        worst = (value, tuple(round(v) for v in bg), tuple(int(round(v)) for v in fg))
        if worst:
            rows.append((worst[0], box["text"][:22], label, worst[1], len(layers), worst[2]))

    rows.sort()
    print("背景图 %dx%d   文字元素 %d 个" % (width, height, len(rows)))
    print("%-22s %-30s %-9s %-6s %s" % ("文字", "前景色", "最差对比", "玻璃层", "有效底色/最差色标"))
    for value, text, color, bg, depth, fg in rows:
        glass = "有" if depth else "—"
        print("  %-20s %-30s %5.2f:1  %-5s %s / #%02X%02X%02X%s"
              % ("「%s」" % text, color, value, glass, bg, fg[0], fg[1], fg[2],
                 "" if value >= 4.5 else "   ← 不达标"))
    print()
    lowest = rows[0]
    print("最低 %.2f:1（%s）→ %s" % (lowest[0], lowest[1],
                                    "全部达标（≥4.5:1）" if lowest[0] >= 4.5 else "仍有不达标"))
    return 0 if lowest[0] >= 4.5 else 1


if __name__ == "__main__":
    sys.exit(main())
