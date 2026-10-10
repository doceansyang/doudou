# -*- coding: utf-8 -*-
"""品牌改名：JinyuTV -> JinyuTV（含目录/文件名）。

为什么必须**大小写敏感**：
  本机 Windows 用户名恰好是 `JinYuDream`（大写 Y、大写 D），
  配置文件与脚本里到处都是 `C:\\Users\\JinYuDream\\...`。
  若做大小写不敏感替换，会把用户名一起改掉 → 所有路径失效、软件报废。
  因此只替换精确的三种写法：
      JinyuTV -> JinyuTV      （品牌显示名 / 文件名 / 目录名）
      jinyutv -> jinyutv      （小写标识符、协议、ini）
      JINYUTV -> JINYUTV      （常量，若有）
  `JinYuDream`（用户名）不会被匹配。

用法：
  python scripts/rename-to-jinyutv.py            # dry-run，只统计
  python scripts/rename-to-jinyutv.py --apply    # 实际改写（自动备份 .orig）
"""
import os
import shutil
import sys
from collections import Counter

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
SOFTWARE = os.path.join(BASE, "JinyuTV-portable")

ROOTS = [PROJECT, SOFTWARE]

# 不进入的目录
SKIP_DIRS = {
    "node_modules", ".git", ".rebrand-backup", "logs", "_build-cache",
    "_junk-backups", ".hutch", "dist", ".vite", "coverage",
}
# 名字带这些前缀/后缀的目录也跳过（我打包时留下的临时/备份目录）
SKIP_DIR_PREFIX = ("_installer-stage",)
SKIP_SUFFIX = (".bak", ".bak2", ".bak3", ".orig", ".manual", ".empty", ".prebuild", ".log")

OLD_NEW = [
    ("JinyuTV", "JinyuTV"),
    ("jinyutv", "jinyutv"),
    ("JINYUTV", "JINYUTV"),
]


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if d not in SKIP_DIRS
            and not d.startswith(SKIP_DIR_PREFIX)
            and not d.endswith(SKIP_SUFFIX)
        ]
        for name in filenames:
            if name.endswith(SKIP_SUFFIX):
                continue
            yield os.path.join(dirpath, name)


def main():
    apply = "--apply" in sys.argv
    stats = Counter()
    changed_files = []

    for root in ROOTS:
        if not os.path.isdir(root):
            print("跳过（不存在）：%s" % root)
            continue
        for path in iter_files(root):
            try:
                with open(path, "rb") as fh:
                    raw = fh.read()
                text = raw.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue  # 二进制或非 UTF-8（如 .png / bun.exe）一律跳过
            new = text
            local = Counter()
            for old, rep in OLD_NEW:
                n = new.count(old)
                if n:
                    new = new.replace(old, rep)
                    local[old] += n
                    stats[old] += n
            if new != text:
                changed_files.append(path)
                if apply:
                    bak = path + ".orig"
                    if not os.path.exists(bak):
                        shutil.copy2(path, bak)
                    with open(path, "w", encoding="utf-8", newline="") as fh:
                        fh.write(new)

    print("=== 内容替换统计（大小写敏感）===")
    for old, rep in OLD_NEW:
        print("  %-12s -> %-10s %d 处" % (old, rep, stats[old]))
    print("  涉及文件：%d 个" % len(changed_files))
    print("  模式：%s" % ("已写入（备份为 *.orig）" if apply else "dry-run（未改动）"))
    print()
    print("=== 抽查受影响文件（前 15 个）===")
    for p in changed_files[:15]:
        print("  " + os.path.relpath(p, BASE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
