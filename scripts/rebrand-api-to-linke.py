#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把「Toonflow 官方中转站」换成我们自己的 API 站点（api.linke.link）。

只改两类内容：
  1. 地址：https://api.toonflow.net  ->  https://api.linke.link
  2. 面向用户的品牌文案：TF-router / TF-Router  ->  Linke

刻意不动：
  · provider 的 id「JinyuDream」、函数名 isJinyuDreamProvider、变量名、文件名 JinyuDream.ts
    —— 这些是内部标识符，改了会让配置与 import 对不上。
  · node_modules / 构建产物 / *.orig 备份

用法：先不带参数跑（dry-run），确认后加 --apply。
"""
import os
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # toonflow/
PORTABLE = os.path.join(os.path.dirname(ROOT), "JinyuTV-portable")
BACKUP = os.path.join(ROOT, ".api-rebrand-backup")

RULES = [
    # 先换地址（含域名），再换品牌文案。
    # 注意：这两种写法都不加 \b —— Python 的 \b 把中文字符也算作单词字符，
    # 遇到「TF-router供应商」这种中文紧邻的文案会匹配不到。
    # 而「JinyuDream」（内部 id、变量名、文件名）是小写 t 开头，不会被这两种写法命中。
    (re.compile(r"https://api\.toonflow\.net"), "https://api.linke.link"),
    (re.compile(r"TF-Router"), "Linke"),
    (re.compile(r"TF-router"), "Linke"),
]

SCAN_DIRS = [
    os.path.join(ROOT, "apps"),
    os.path.join(ROOT, "packages"),
    os.path.join(ROOT, "data", "providers"),
    os.path.join(PORTABLE, "data", "providers"),
]
SUFFIXES = (".ts", ".vue", ".js", ".json", ".mjs", ".html")
SKIP_PARTS = ("node_modules", os.sep + "build" + os.sep, ".orig", ".api-rebrand-backup")


def targets():
    for base in SCAN_DIRS:
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "build", "dist", ".git")]
            for name in filenames:
                if not name.endswith(SUFFIXES):
                    continue
                path = os.path.join(dirpath, name)
                if any(part in path for part in SKIP_PARTS):
                    continue
                yield path


def main():
    apply = "--apply" in sys.argv
    files, hits = 0, 0
    detail = []
    for path in targets():
        try:
            with open(path, encoding="utf-8", newline="") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        new = text
        counts = []
        for pattern, repl in RULES:
            new, n = pattern.subn(repl, new)
            if n:
                counts.append((pattern.pattern, n))
        if new == text:
            continue
        files += 1
        total = sum(n for _, n in counts)
        hits += total
        rel = os.path.relpath(path, os.path.dirname(ROOT))
        detail.append((rel, counts))

        if apply:
            backup = os.path.join(BACKUP, os.path.relpath(path, os.path.dirname(ROOT)))
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            if not os.path.exists(backup):
                shutil.copy2(path, backup)
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(new)

    print("%s：%d 个文件、%d 处替换\n" % ("已应用" if apply else "dry-run", files, hits))
    for rel, counts in detail[:40]:
        print("  %-58s %s" % (rel, "、".join("%s×%d" % (p, n) for p, n in counts)))
    if len(detail) > 40:
        print("  ...还有 %d 个文件" % (len(detail) - 40))
    if apply:
        print("\n原文件已备份到：%s" % BACKUP)


if __name__ == "__main__":
    main()
