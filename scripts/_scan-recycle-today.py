# -*- coding: utf-8 -*-
"""快速版：只解码"今天删除"的回收站条目（$I 文件的修改时间≈删除时间）。

全量扫描回收站太慢（元数据文件成千上万）。这里先按 mtime 过滤，再解码原始路径。
"""
import datetime
import os
import struct
import time

TODAY = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
KEYWORDS = ("toonflow", "jinyu")


def decode(path):
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError:
        return None
    if len(blob) < 24:
        return None
    version = struct.unpack_from("<Q", blob, 0)[0]
    size = struct.unpack_from("<Q", blob, 8)[0]
    try:
        ticks = struct.unpack_from("<Q", blob, 16)[0]
        when = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ticks / 10)
    except Exception:  # noqa: BLE001
        when = None
    if version == 2 and len(blob) >= 28:
        name_len = struct.unpack_from("<I", blob, 24)[0]
        raw = blob[28:28 + name_len * 2]
    else:
        raw = blob[24:]
    return when, size, raw.decode("utf-16-le", "replace").rstrip("\x00")


def main():
    scanned = fresh = 0
    hits = []
    recent = []
    for drive in ("C:", "D:"):
        root = drive + "\\$Recycle.Bin"
        if not os.path.isdir(root):
            continue
        for sid in os.listdir(root):
            sid_dir = os.path.join(root, sid)
            if not os.path.isdir(sid_dir):
                continue
            try:
                names = os.listdir(sid_dir)
            except OSError:
                continue
            for name in names:
                if not name.startswith("$I"):
                    continue
                scanned += 1
                full = os.path.join(sid_dir, name)
                try:
                    if os.path.getmtime(full) < TODAY:
                        continue
                except OSError:
                    continue
                fresh += 1
                meta = decode(full)
                if not meta:
                    continue
                when, size, original = meta
                recent.append((when, size, original))
                if any(k in original.lower() for k in KEYWORDS):
                    hits.append((when, size, original))

    print("回收站元数据文件总数: %d；其中今天删除的: %d" % (scanned, fresh))
    print()
    print("=== 今天被删除的条目（最多 25 条）===")
    if not recent:
        print("  （今天没有新删除的条目）")
    for when, size, original in sorted(recent, key=lambda x: x[0] or datetime.datetime.min, reverse=True)[:25]:
        print("  %s  %8.1f MB  %s" % (when.strftime("%m-%d %H:%M:%S") if when else "????", size / 1048576, original))
    print()
    print("=== 命中 Toonflow / Jinyu 的条目 ===")
    print("  （无）" if not hits else "")
    for when, size, original in hits:
        print("  %s  %8.1f MB  %s" % (when.strftime("%m-%d %H:%M:%S") if when else "????", size / 1048576, original))


if __name__ == "__main__":
    main()
