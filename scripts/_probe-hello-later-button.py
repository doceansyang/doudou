# -*- coding: utf-8 -*-
"""判定引导页「稍后配置」的高亮是否成立 —— 用户口径是**只换颜色、样式不动**。

两路证据：
  · `_hello-later-meta.json`（探针取的 computed 值）—— 配色比字符串差异、几何比逐项相等。
  · `_btn-*.png`（探针截的按钮小图）—— 实况像素，回答"肉眼看到的是不是那套紫/品红"。

判据：
  ① 挂上了 laterButton
  ② 颜色确实换了（文字色 / 背景渐变 / 描边 三项都与旁边的次要按钮不同）
  ③ **几何逐项相同**（高、字号、字重、圆角、内边距、盒模型）—— 这条就是"样式没动"的验收
  ④ 实况像素：底色是紫/品红系（蓝最高、绿最低），文字是亮色
  ⑤ 对比度足够
"""
import json
import warnings
from pathlib import Path

from PIL import Image

warnings.simplefilter("ignore", DeprecationWarning)

OUT = Path("scripts/_out")
meta = json.loads((OUT / "_hello-later-meta.json").read_text(encoding="utf-8"))


def luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def analyze(path: Path):
    """取按钮的底色与文字色。

    ⚠️ 底色**不能用众数**：这颗按钮是渐变的，没有任何一种颜色占多数（每条垂直于渐变轴
    的扫描线上颜色都不同），众数会退化成圆角外的页面底色（实测 (20,20,20)），把紫渐变
    判成黑灰 —— 第一版就栽在这。
    改成取「左侧内边距区」的平均色（在圆角内、文字外，稳定落在渐变左端）；
    文字色取内区最亮的 1% 像素的平均（白字远亮于任何一档渐变色）。
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size

    x0, x1 = max(1, round(w * 0.05)), max(2, round(w * 0.17))
    y0, y1 = round(h * 0.36), round(h * 0.64)
    patch = [im.getpixel((x, y)) for x in range(x0, x1) for y in range(y0, y1)]
    bg = tuple(round(sum(p[i] for p in patch) / len(patch)) for i in range(3))
    bg_l = luma(bg)

    inner = im.crop((4, 4, w - 4, h - 4))
    pixels = sorted(inner.getdata(), key=luma, reverse=True)
    top = pixels[: max(1, len(pixels) // 100)]
    fg = tuple(round(sum(p[i] for p in top) / len(top)) for i in range(3))

    return {
        "size": f"{w}x{h}",
        "bg": bg,
        "bg_lum": round(bg_l),
        "fg": fg,
        "fg_lum": round(luma(fg)),
        "contrast": round(abs(luma(fg) - bg_l)),
        "is_bg_violet": bg[2] > bg[1] + 40 and bg[0] > bg[1],
    }


later_px = analyze(OUT / "_btn-later.png")
custom_px = analyze(OUT / "_btn-custom.png")

later, custom, login = meta["later"], meta["custom"], meta["login"]
print(f"主题={meta['theme']}　主色={meta['primary']}\n")
print("稍后配置 computed :", json.dumps({k: later[k] for k in ("color", "borderColor", "backgroundImage", "geometry")}, ensure_ascii=False))
print("添加私有 computed :", json.dumps({k: custom[k] for k in ("color", "borderColor", "backgroundImage", "geometry")}, ensure_ascii=False))
print(f"\n稍后配置 像素 : {later_px}")
print(f"添加私有 像素 : {custom_px}\n")

failures = 0


def check(label, passed, detail=""):
    global failures
    print(f"{'✓' if passed else '✗'} {label}{'　' + detail if detail else ''}")
    if not passed:
        failures += 1


check("① 挂上了 laterButton", "laterButton" in later["classes"])

changed = [k for k in ("color", "borderColor", "backgroundImage") if later[k] != custom[k]]
check("② 配色确实换了（文字 / 描边 / 背景渐变）", len(changed) == 3, f"变了 {changed}")

# 「只改颜色不要改样式」的核心验收：几何逐项相同（宽度随文字长度变化，不参与比较）
keys = ["height", "fontSize", "fontWeight", "borderRadius", "padding", "boxSizing"]
diff = {k: (custom["geometry"][k], later["geometry"][k]) for k in keys if custom["geometry"][k] != later["geometry"][k]}
check("③ 几何逐项与旁边的次要按钮相同（样式没动）", not diff, f"差异 {diff}" if diff else " | ".join(f"{k}={later['geometry'][k]}" for k in keys))

check("④ 实况底色是紫 / 品红系", later_px["is_bg_violet"], f"底色 {later_px['bg']}（蓝>绿且红>绿）")
check("⑤ 实况文字是亮色（白字）", later_px["fg_lum"] > 200, f"文字 {later_px['fg']} luma={later_px['fg_lum']}")
check("⑥ 对比度足够", later_px["contrast"] > 60, f"{later_px['contrast']}")
check("⑦ 主按钮仍是页面唯一实心大按钮", login["size"] == "420x50", f"主按钮 {login['size']}")

hover = meta.get("hovered") or {}
print(f"悬停态：{json.dumps(hover, ensure_ascii=False)}")
check(
    "⑧ 悬停仍是白字 + 透明描边 + 渐变（没被全局深色规则改成灰字灰边）",
    hover.get("color") == "rgb(255, 255, 255)"
    and "rgba(0, 0, 0, 0)" == hover.get("borderColor")
    and "linear-gradient" in str(hover.get("backgroundImage")),
)
check("⑨ 页面无脚本错误", not meta.get("pageErrors"), str(meta.get("pageErrors")))

print(f"\n{'全部通过' if not failures else f'{failures} 条未通过'}")
raise SystemExit(1 if failures else 0)
