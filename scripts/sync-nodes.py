# -*- coding: utf-8 -*-
"""重建节点包，并同步到**所有实例的两处**（build/nodes 与 data/nodes）。

为什么需要这个脚本（`dev-update.py --only nodes` 不够）：
  1. `dev-update.py` 的 `sync_runtime_plugins()` 只同步到「绿色版 + 项目目录」，
     **不含安装版** —— 而用户实际在用的是安装版。
  2. 更隐蔽的是：只写 `data/nodes` **会被静默回滚**。应用启动时会用
     `<实例>/build/nodes` 重新铺一遍 `<实例>/data/nodes`，于是上一次的同步白做。
     实测：13:13 写进 data/nodes 的新节点，13:33 启动后又被旧版盖回去了。

判据别用文件时间戳 —— `shutil.copy2` 会保留源文件 mtime，复制成功也看着是旧的。
本脚本结束后会**搜内容**复核，并打印每个位置的结果。

用法：
  python scripts/sync-nodes.py            # 构建 + 同步
  python scripts/sync-nodes.py --skip-build   # 只同步（改的是别处时）
"""
import argparse
import os
import shutil
import subprocess

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
# 复核方式：与项目刚构建出的 build/nodes 逐个比哈希（见 verify()）。
# 早先这里是「搜产物里的供应商优先级字面量」，但那个串会被压缩器改写/消失，
# 构建方式一变就稳定误报，已弃用。
TARGETS = [
    "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV"),
]


def build_env():
    root = os.environ.get("SystemRoot", r"C:\Windows")
    env = dict(os.environ, NODE_ENV="production",
               PATH=os.pathsep.join([os.path.join(root, "System32"), root,
                                     os.path.dirname(BUN), os.environ.get("PATH", "")]))
    for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
        env.pop(key, None)
    return env


def build():
    print("--- 构建节点包（./packages/nodes/*）")
    proc = subprocess.run([BUN, "run", "--filter", "./packages/nodes/*", "build"],
                          cwd=PROJECT, env=build_env(), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    tail = [ln for ln in (proc.stdout or "").strip().splitlines() if ln.strip()][-3:]
    for line in tail:
        print("    " + line)
    if proc.returncode != 0:
        print((proc.stderr or "")[-1500:])
        raise SystemExit("!! 节点构建失败")


def sync():
    src = os.path.join(PROJECT, "build", "nodes")
    if not os.path.isdir(src):
        raise SystemExit("找不到 %s" % src)
    names = [f for f in os.listdir(src) if f.endswith(".umd.js")]
    print("--- 源：%d 个 umd" % len(names))
    for base in TARGETS:
        if not os.path.isdir(base):
            print("    ! 实例不存在，跳过：%s" % base)
            continue
        for sub in ("build", "data"):
            dst = os.path.join(base, sub, "nodes")
            os.makedirs(dst, exist_ok=True)
            n = 0
            for name in names:
                try:
                    shutil.copy2(os.path.join(src, name), os.path.join(dst, name))
                    n += 1
                except OSError as error:
                    print("    ! %s（%s）" % (name, error))
            print("    %s/%s/nodes ← %d 个" % (os.path.basename(base), sub, n))


def digest(path):
    """文件内容哈希（前 12 位）。复核用它的原因见 verify()。"""
    import hashlib
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()[:12]


def verify():
    """复核 = 与「项目 build/nodes 刚构建出来的那份」**逐字节比哈希**。

    为什么不用标记串（原来搜 `groupNodeModels` 里的供应商优先级表）：
    那个串是**压缩器内联出来的字面量**，构建方式一变（哪怕只改了一行注释影响内联顺序）
    它就消失了，于是复核「稳定失败」—— 实测被这个坑过一次：新节点其实已经进包
    （`grep imageRatioMap` 能搜到），但复核报 ✗，白排查一轮。
    哈希比对既与构建细节无关，又能真正回答「每个位置是不是这份产物」。
    """
    print("--- 复核（与项目 build/nodes 逐个比哈希）")
    ok = True
    src = os.path.join(PROJECT, "build", "nodes")
    names = [f for f in os.listdir(src) if f.endswith(".umd.js")]
    want = {name: digest(os.path.join(src, name)) for name in names}
    for label, dst in [("项目 build/nodes", src)] + [
        ("%s/%s/nodes" % (os.path.basename(b), s), os.path.join(b, s, "nodes"))
        for b in TARGETS for s in ("build", "data")
    ]:
        bad = [name for name in names
               if not os.path.exists(os.path.join(dst, name))
               or digest(os.path.join(dst, name)) != want[name]]
        ok = ok and not bad
        print("    %s %s（%d/%d 一致%s）" % (
            "✓" if not bad else "✗", label, len(names) - len(bad), len(names),
            "" if not bad else "，不一致：" + "、".join(bad[:3])))
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if not args.skip_build:
        build()
    sync()
    if not verify():
        raise SystemExit("!! 复核未通过：有些位置没拿到新节点")
    print("\n完成。记得**重启一次应用**才会加载新节点。")


if __name__ == "__main__":
    main()
