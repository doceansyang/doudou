# -*- coding: utf-8 -*-
"""把 JinyuTV 的 logo 装进 Toonflow 项目（替换为自有品牌图标）。

源图：C:/Users/JinYuDream/jinyutv-app/assets/logo-circle.png（419x419，RGB+alpha，圆外透明、圆内黑底）
产出三套，按用途区分：

  1. packages/assets/logo.svg        —— 界面用：**抠掉黑底**、只留彩色花形
       为什么要抠：conversation.vue 用 `mask-image: url(logo.svg)` 只取 alpha 通道，
       黑底不透明会让蒙版变成一整块实心色块；抠掉后蒙版就是花形轮廓，浅色界面上也好看。
  2. packages/assets/logo.ico        —— Windows 图标：沿用黑底圆形（16/24/32/48/64/128/256）
  3. packages/assets/logo.iconset/*  —— macOS 图标：沿用黑底圆形（MAC 标准 10 个尺寸）

原文件备份到 .rebrand-backup/packages/assets/。
"""
import base64
import io
import os
import shutil

from PIL import Image

SRC = "C:/Users/JinYuDream/jinyutv-app/assets/logo-circle.png"
PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
ASSETS = os.path.join(PROJECT, "packages", "assets")
BACKUP = os.path.join(PROJECT, ".rebrand-backup", "packages", "assets")

# 抠黑底阈值：亮度 <= LOW 视为纯背景，>= HIGH 视为纯前景，中间线性过渡（保留边缘羽化）
LOW, HIGH = 6, 48


def backup(path):
    if not os.path.exists(path):
        return
    target = os.path.join(BACKUP, os.path.basename(path))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not os.path.exists(target):
        shutil.copy2(path, target)


def cutout_black(src: Image.Image) -> Image.Image:
    """把近似黑的背景转成透明，保留彩色花形与边缘羽化。"""
    im = src.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = max(r, g, b)
            if lum <= LOW:
                px[x, y] = (r, g, b, 0)
            elif lum < HIGH:
                px[x, y] = (r, g, b, int(a * (lum - LOW) / (HIGH - LOW)))
    return im


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main():
    src = Image.open(SRC)
    print("源图: %s %s %s" % (SRC, src.size, src.mode))

    # ---- 1) 界面用 SVG ----
    # 沿用「黑底圆形」原设计：圆形外本来透明，圆内黑底是 logo 的组成部分。
    # 不做抠黑 —— 花瓣与黑底之间是渐变过渡、没有硬边界，任何亮度阈值都会
    # 要么在花瓣边缘留黑边、要么把后方深紫色花瓣抠成半透明灰。
    shape = src.convert("RGBA")
    bbox = shape.getbbox()  # 裁掉圆形外多余的透明边
    if bbox:
        shape = shape.crop(bbox)
    print("  logo 尺寸（裁剪后）: %s" % (shape.size,))

    data = base64.b64encode(png_bytes(shape)).decode("ascii")
    w, h = shape.size
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="0 0 %d %d" width="%d" height="%d" preserveAspectRatio="xMidYMid meet">'
        '<image width="%d" height="%d" xlink:href="data:image/png;base64,%s"/></svg>'
    ) % (w, h, w, h, w, h, data)

    svg_path = os.path.join(ASSETS, "logo.svg")
    backup(svg_path)
    with open(svg_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(svg)
    print("已写入 %s (%.1f KB)" % (svg_path, len(svg) / 1024))

    # ---- 2) Windows 图标：黑底圆形 ----
    circle = src.convert("RGBA")
    ico_path = os.path.join(ASSETS, "logo.ico")
    backup(ico_path)
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    circle.save(ico_path, format="ICO", sizes=sizes)
    print("已写入 %s %s" % (ico_path, sizes))

    # ---- 3) macOS iconset ----
    iconset = os.path.join(ASSETS, "logo.iconset")
    os.makedirs(iconset, exist_ok=True)
    plan = ["icon_16x16.png:16", "icon_16x16@2x.png:32", "icon_32x32.png:32", "icon_32x32@2x.png:64",
            "icon_128x128.png:128", "icon_128x128@2x.png:256", "icon_256x256.png:256",
            "icon_256x256@2x.png:512", "icon_512x512.png:512", "icon_512x512@2x.png:1024"]
    for item in plan:
        name, size = item.split(":")
        size = int(size)
        target = os.path.join(iconset, name)
        backup(target)
        resized = circle.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(target, format="PNG", optimize=True)
    print("已写入 iconset 共 %d 个尺寸（1024 由 419 源图放大，可能略软）" % len(plan))
    print("备份目录: %s" % BACKUP)


if __name__ == "__main__":
    main()
