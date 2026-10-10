"""把 playwright 运行库打进绿色版，使软件脱离「本机 bun 全局缓存」也能跑。

背景：
  绿色版复制时没带 node_modules，RPA 里的 `import("playwright")` 是**运行时动态导入**，
  当前是靠本机 bun 的全局缓存（~/.bun/install/cache/playwright@1.64.0）解析到的。
  换个干净机器（或清过 bun 缓存）就会失败 —— 而服务健康检查照样是 ok，
  要等到真正点生成才炸，属于隐蔽缺口。

做法：
  从项目 node_modules 复制 playwright + playwright-core 到 软件目录/node_modules/，
  并把它们的依赖一并带上（playwright 只依赖 playwright-core）。
不删除任何文件（规避批量删除守卫），已存在则跳过不覆盖。
"""

import os
import shutil
import sys

PROJECT = r"C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
SOFTWARE = r"C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable"

# 需要随包携带的包（playwright 运行时真正 import 的）
PACKAGES = ["playwright", "playwright-core"]


def resolve_source(name: str, seen: set | None = None) -> str | None:
    """在项目 node_modules 里定位包的真实目录（可能被 bun 做了软链）。"""
    seen = seen or set()
    path = os.path.join(PROJECT, "node_modules", name)
    if not os.path.exists(path):
        return None
    real = os.path.realpath(path)
    return real


def copy_package(name: str, dst_root: str) -> int:
    src = resolve_source(name)
    if not src or not os.path.isdir(src):
        print("  !! 项目里找不到 %s，跳过" % name)
        return 0
    dst = os.path.join(dst_root, name)
    if os.path.exists(dst):
        print("  = %s 已存在，跳过" % name)
        return 0
    # symlinks=False：把 bun 缓存里的软链实体化，保证换机可用
    shutil.copytree(src, dst, symlinks=False, ignore_dangling_symlinks=True)
    count = sum(len(files) for _, _, files in os.walk(dst))
    size = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(dst) for f in fs
        if os.path.exists(os.path.join(dp, f))
    )
    print("  ✓ %s -> %.1f MB / %d 文件" % (name, size / 1048576, count))
    return count


def main() -> int:
    if not os.path.isdir(SOFTWARE):
        print("!! 找不到软件目录：%s" % SOFTWARE)
        return 1

    dst_root = os.path.join(SOFTWARE, "node_modules")
    os.makedirs(dst_root, exist_ok=True)

    print("=== 将 playwright 运行库打进软件目录 ===")
    total = 0
    for pkg in PACKAGES:
        total += copy_package(pkg, dst_root)

    print("\n=== 验证：从软件目录解析 playwright 应指向软件自身 ===")
    print("预期路径前缀：%s" % dst_root.replace("/", "\\"))
    print("（下方用 bun 实测）")
    return 0 if total else 0


if __name__ == "__main__":
    sys.exit(main())
