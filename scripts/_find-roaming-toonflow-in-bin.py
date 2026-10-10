# -*- coding: utf-8 -*-
"""在回收站里精确找「原版 Toonflow 数据目录」（避开用户名 JinYuDream 造成的误命中）。

注意：不能用 "jinyu" 当关键词 —— 用户目录本身就叫 JinYuDream，
      `C:\\Users\\JinYuDream\\...` 会让所有条目都命中。这里匹配 AppData\\Roaming\\Toonflow。
"""
import datetime
import os
import struct

TODAY = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
NEEDLE = "roaming\\toonflow"


def decode(path):
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError:
        return None
    if len(blob) < 28:
        return None
    version = struct.unpack_from("<Q", blob, 0)[0]
    size = struct.unpack_from("<Q", blob, 8)[0]
    try:
        ticks = struct.unpack_from("<Q", blob, 16)[0]
        when = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ticks / 10)
    except Exception:  # noqa: BLE001
        when = None
    if version == 2:
        name_len = struct.unpack_from("<I", blob, 24)[0]
        raw = blob[28:28 + name_len * 2]
    else:
        raw = blob[24:]
    return when, size, raw.decode("utf-16-le", "replace").rstrip("\x00")


def main():
    today_total = today_decoded = 0
    hits = []
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
                full = os.path.join(sid_dir, name)
                try:
                    if os.path.getmtime(full) < TODAY:
                        continue
                except OSError:
                    continue
                today_total += 1
                meta = decode(full)
                if not meta:
                    continue
                today_decoded += 1
                when, size, original = meta
                low = original.lower().replace("/", "\\")
                if NEEDLE in low:
                    hits.append((when, size, original))

    print("今天删除的回收站条目数: %d（成功解码 %d）" % (today_total, today_decoded))
    print()
    print("=== 原始路径含 AppData\\Roaming\\Toonflow 的条目 ===")
    if not hits:
        print("   （无）")
        print("   → 说明它不是被删到回收站（可能被彻底删除，或由某个程序直接移除）")
    for when, size, original in sorted(hits, key=lambda x: x[0] or datetime.datetime.min, reverse=True):
        print("   %s  %8.1f MB  %s" % (when.strftime("%m-%d %H:%M:%S") if when else "????", size / 1048576, original))


if __name__ == "__main__":
    main()
