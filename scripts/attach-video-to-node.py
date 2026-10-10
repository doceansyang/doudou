# -*- coding: utf-8 -*-
"""把已生成的 mp4 手动挂回画布节点的 outputs.video（断线丢失时的补救）。

用法：
  python scripts/attach-video-to-node.py <画布json> <节点id> <mp4源文件>

做三件事：
  1. 备份画布 json（*.bak）
  2. 把 mp4 复制到 <workspace>/assets/<节点id>/<uuid>.mp4（与节点生成时的 outputDirectory 规则一致）
  3. 把 outputs.video 写成 { dataType: "VIDEO", value: { url, mimeType } }

注意：改完需要在前端**刷新画布**才会看到；若前端仍在编辑，它的自动保存可能覆盖这次修改。
"""
import glob
import json
import os
import shutil
import sys
import uuid


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    canvas_path = sys.argv[1]
    node_id = sys.argv[2]
    pattern = sys.argv[3]

    srcs = sorted(glob.glob(pattern))
    if not srcs:
        print("找不到源文件：%s" % pattern)
        return 1
    src = srcs[-1]

    workspace = os.path.dirname(os.path.abspath(canvas_path))
    dest_dir = os.path.join(workspace, "assets", node_id)
    os.makedirs(dest_dir, exist_ok=True)
    name = "%s.mp4" % uuid.uuid4()
    dest = os.path.join(dest_dir, name)
    shutil.copy2(src, dest)

    backup = canvas_path + ".bak"
    shutil.copy2(canvas_path, backup)

    with open(canvas_path, encoding="utf-8") as fh:
        data = json.load(fh)

    url = "assets/%s/%s" % (node_id, name)
    hit = False
    for node in data.get("nodes", []):
        if node.get("id") == node_id:
            node.setdefault("data", {})["outputs"] = {
                "video": {"dataType": "VIDEO", "value": {"url": url, "mimeType": "video/mp4"}}
            }
            hit = True
    if not hit:
        print("画布里找不到节点：%s" % node_id)
        return 1

    with open(canvas_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print("源文件   : %s" % src)
    print("复制到   : %s (%d 字节)" % (dest, os.path.getsize(dest)))
    print("节点输出 : %s -> %s" % (node_id, url))
    print("备份     : %s" % backup)
    print("→ 请在前端刷新画布页面查看")
    return 0


if __name__ == "__main__":
    sys.exit(main())
