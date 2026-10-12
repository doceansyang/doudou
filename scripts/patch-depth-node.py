# -*- coding: utf-8 -*-
"""把「视频深度动捕」(depthCaptureNode) 的模型源改指到本机同源代理。

为什么要打这个补丁
------------------
该节点在 WebView2 页面里**直接 fetch 模型权重**，而模型源（ModelScope / hf-mirror）
不返回 `Access-Control-Allow-Origin` → 浏览器一律判 `TypeError: Failed to fetch`。
实测证据（同一台机器、同一时刻）：
  · 终端 curl（直连 / 走系统代理）→ ModelScope、hf-mirror、jsDelivr 全 200；
  · 页面（从 http://localhost:3000 发起）→ **0ms** 失败，控制台明写
    `blocked by CORS policy: No 'Access-Control-Allow-Origin' header`。
⇒ 不是网络问题、不是代理问题，是 CORS。

本机服务端已新增同源代理 `/api/modelSource`（见 apps/server/src/routes/modelSource.ts），
把节点里 ModelScope 源的 host 由 `https://modelscope.cn` 换成本机地址即可正常下载。

⚠️ 节点是**市场装的三方插件**（identifier=depthCaptureNode，显示名「视频动作捕捉」）。
    一旦在市场里重装/更新该插件，补丁会被覆盖 —— 届时**重跑本脚本**即可。
    （`scripts/sync-nodes.py` 只同步仓库里的 8 个内置节点，不会覆盖这个市场节点。）

用法：
  python scripts/patch-depth-node.py            # 打补丁（幂等）
  python scripts/patch-depth-node.py --check     # 只看状态，不写盘
  python scripts/patch-depth-node.py --restore   # 还原成原始文件
"""
import argparse
import os
import shutil
import sys

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
NODE_FILE = "depthCaptureNode.umd.js"
ORIG = "https://modelscope.cn/api/v1/models"
PATCHED = "http://localhost:3000/api/modelSource/api/v1/models"
BACKUP = os.path.join(PROJECT, "scripts", "_out", "depth-node-backup")

# 市场节点只落在 data/nodes（build/nodes 里没有），但两处都扫，避免以后变位置漏掉。
INSTANCES = [
    ("绿色版", "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable"),
    ("安装版", os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")),
]
SUBDIRS = ("build", "data")


def targets():
    for label, base in INSTANCES:
        for sub in SUBDIRS:
            path = os.path.join(base, sub, "nodes", NODE_FILE)
            if os.path.isfile(path):
                yield label, sub, path


def state(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    has_orig, has_patched = text.count(ORIG), text.count(PATCHED)
    if has_patched and not has_orig:
        return "已打补丁", text
    if has_orig and not has_patched:
        return "未打补丁", text
    return "状态异常（两种串同时存在或都缺失）", text


def backup(label, sub, path):
    dest = os.path.join(BACKUP, label, sub, NODE_FILE)
    if os.path.isfile(dest):
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(path, dest)
    return dest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只看状态")
    parser.add_argument("--restore", action="store_true", help="还原")
    args = parser.parse_args()

    found = list(targets())
    if not found:
        print("!! 找不到 %s —— 插件可能没装，或安装位置变了" % NODE_FILE)
        return 1

    failed = 0
    for label, sub, path in found:
        status, text = state(path)
        print("%-6s %-5s %s" % (label, sub, status))
        if args.check:
            continue

        if args.restore:
            saved = os.path.join(BACKUP, label, sub, NODE_FILE)
            if not os.path.isfile(saved):
                print("       ! 没有备份，跳过")
                failed += 1
                continue
            shutil.copy2(saved, path)
            print("       → 已还原")
            continue

        if status == "已打补丁":
            print("       = 无需改动")
            continue
        if status != "未打补丁":
            print("       ! 内容异常，拒绝改写（请人工核对）")
            failed += 1
            continue

        # 只在「恰好 1 处」时替换，多了少了都说明版本变了，宁可报错也不瞎改。
        if text.count(ORIG) != 1:
            print("       ! 命中 %d 次（预期 1 次），版本可能变了，拒绝改写" % text.count(ORIG))
            failed += 1
            continue

        saved = backup(label, sub, path)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text.replace(ORIG, PATCHED))
        print("       → 已打补丁（原文件备份在 %s）" % saved)

    if args.check:
        print("\n（--check 模式，未写盘）")
    elif failed:
        print("\n!! %d 处需要人工处理" % failed)
        return 1
    else:
        print("\n完成。重启软件后生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
