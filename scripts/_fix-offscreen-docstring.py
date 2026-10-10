# -*- coding: utf-8 -*-
"""统一更新「浏览器窗口在屏幕外」相关文案（该行为已取消）与浏览器前置条件说明。"""
import pathlib

FILES = [
    "scripts/doubao-rpa-core.ts",
    "data/providers/doubaoAccount.ts",
    "packages/providers/src/media/doubaoAccount.ts",
    # 绿色版里的运行时副本
    "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable/scripts/doubao-rpa-core.ts",
    "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable/data/providers/doubaoAccount.ts",
]

RULES = [
    (
        " * 后台运行时把窗口挪到屏幕外（--window-position=-32000,-32000），不抢焦点。",
        " * 窗口始终开在屏幕内，用户可随时查看；需要扫码或人工验证时会自动置顶。",
    ),
    (
        "- 生成时会在屏幕外开一个真实 Chrome 窗口操作豆包网页（豆包风控会识别无头浏览器，必须真实窗口）。",
        "- 生成时会打开一个真实 Chrome 窗口操作豆包网页（窗口在屏幕内，可随时查看；"
        "需要扫码登录或人工验证时会自动移到最前）。",
    ),
    (
        "- 生成时会有一个真实 Chrome 窗口在屏幕外工作，属正常现象（豆包风控会识别无头浏览器）。",
        "- 生成时会打开一个真实 Chrome 窗口（在屏幕内，可随时查看）；"
        "需要扫码或人工验证时窗口会自动置顶。",
    ),
    (
        "2. 本机需已安装 Google Chrome。",
        "2. 本机需已安装 Chrome 或 Edge（Windows 10/11 自带 Edge，无需额外安装）。",
    ),
]


def main():
    for rel in FILES:
        path = pathlib.Path(rel)
        if not path.exists():
            print("  跳过（不存在）：%s" % rel)
            continue
        text = path.read_text(encoding="utf-8")
        original = text
        hits = 0
        for old, new in RULES:
            if old in text:
                text = text.replace(old, new)
                hits += 1
        if text != original:
            path.write_text(text, encoding="utf-8")
            print("  ✓ %s（更新 %d 处）" % (rel, hits))
        else:
            print("  - %s（无需改动）" % rel)


if __name__ == "__main__":
    main()
