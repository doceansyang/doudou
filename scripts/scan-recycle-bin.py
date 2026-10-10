# -*- coding: utf-8 -*-
"""扫描回收站，找出原始路径含 Toonflow / Jinyu 的条目（判断能否恢复）。

回收站底层格式（Vista+）：每个卷的 $Recycle.Bin/<SID>/ 下有
  $I<id><ext>  元数据：版本(8) 大小(8) 删除时间FILETIME(8) [v2: 名称长度(4)] 原始路径(UTF-16LE)
  $R<id><ext>  实际内容
"""
import datetime
import os
import struct

DRIVES = ["C:", "D:"]
KEYWORDS = ("toonflow", "jinyu")


def parse_meta(path):
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
    total = 0
    hits = []
    for drive in DRIVES:
        root = drive + "\\$Recycle.Bin"
        if not os.path.isdir(root):
            print("  无回收站目录: %s" % root)
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
                total += 1
                meta = parse_meta(os.path.join(sid_dir, name))
                if not meta:
                    continue
                when, size, original = meta
                if any(k in original.lower() for k in KEYWORDS):
                    hits.append((drive, when, size, original, name))

    print("回收站元数据条目总数: %d" % total)
    print()
    print("=== 原始路径命中 Toonflow / Jinyu 的条目 ===")
    if not hits:
        print("  （无）—— 说明不是被删除到回收站，或回收站已被清空")
    for drive, when, size, original, name in sorted(
            hits, key=lambda x: (x[1] or datetime.datetime.min), reverse=True):
        stamp = when.strftime("%m-%d %H:%M:%S") if when else "????"
        print("  %s  %s  %8.1f MB  %s" % (drive, stamp, size / 1048576, original))
        print("      回收站内对应: %s" % name.replace("$I", "$R", 1))


if __name__ == "__main__":
    main()
