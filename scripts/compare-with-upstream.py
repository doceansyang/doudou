# -*- coding: utf-8 -*-
"""比对「上游 Toonflow 完整源码」与「我们的 JinyuTV 项目」，找出漏搬/新增的文件。

用途：用户问「原版 Toonflow 你没有全搬运过来吧？只搬运了画布？」——
必须用事实回答：逐文件列出上游有而我们没有的（漏搬），以及我们额外加的。

排除：node_modules / .git / 构建产物 build / 运行时数据 data / 备份 .orig / .rebrand-backup
"""
import os
from collections import Counter

UPSTREAM = r"C:/Users/JinYuDream/AppData/Local/Temp/toonflow_dl/Toonflow-app-master"
OURS = r"C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"

SKIP_DIRS = {"node_modules", ".git", "build", "data", "dist", ".vite", ".rebrand-backup",
             ".hutch", "coverage", "logs"}
SKIP_SUFFIX = (".orig", ".bak", ".bak2", ".bak3", ".manual", ".empty", ".prebuild", ".log")


def collect(root):
    found = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(SKIP_SUFFIX)]
        for name in filenames:
            if name.endswith(SKIP_SUFFIX):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace("\\", "/")
            found[rel] = os.path.getsize(os.path.join(dirpath, name))
    return found


def main():
    up = collect(UPSTREAM)
    ours = collect(OURS)
    print("上游源码文件数（排除依赖/构建/数据）: %d" % len(up))
    print("我们项目文件数                  : %d" % len(ours))
    print()

    missing = sorted(set(up) - set(ours))
    added = sorted(set(ours) - set(up))

    print("=== ① 上游有、我们没有的（= 真正漏搬的）: %d 个 ===" % len(missing))
    if not missing:
        print("  （无 —— 上游文件一个没少）")
    for rel in missing[:60]:
        print("   · %s" % rel)
    if len(missing) > 60:
        print("   … 另有 %d 个" % (len(missing) - 60))

    print()
    print("=== ② 我们有、上游没有的（= 我们新增/改名的）: %d 个 ===" % len(added))
    buckets = Counter()
    for rel in added:
        top = rel.split("/")[0]
        buckets[top] += 1
    for name, count in buckets.most_common(20):
        print("   %-28s %d 个" % (name, count))
    print()
    print("   明细（前 60）:")
    for rel in added[:60]:
        print("   + %s" % rel)

    print()
    print("=== ③ 同名文件内容是否一致（抽样 20 个，看是否被我们改过）===")
    same = diff = 0
    differ_names = []
    for rel in sorted(set(up) & set(ours)):
        p1, p2 = os.path.join(UPSTREAM, rel), os.path.join(OURS, rel)
        try:
            with open(p1, "rb") as f1, open(p2, "rb") as f2:
                if f1.read() == f2.read():
                    same += 1
                else:
                    diff += 1
                    if len(differ_names) < 20:
                        differ_names.append(rel)
        except OSError:
            pass
    print("   内容完全相同: %d 个；有差异: %d 个" % (same, diff))
    print("   有差异的文件（前 20，多为品牌改名）:")
    for rel in differ_names:
        print("   ~ %s" % rel)


if __name__ == "__main__":
    main()
