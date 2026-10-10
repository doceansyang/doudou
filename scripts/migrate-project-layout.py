# -*- coding: utf-8 -*-
"""把「项目目录 = workspaces 根」的旧布局，迁移成「一个项目 = workspaces 下的一个独立文件夹」。

为什么必须迁：
  老版本的默认项目直接指向 `data/workspaces`（仓库根）。于是
    · 「文档」面板会把 workspaces 下的 _before-migrate、旧项目目录、assets 全倒出来；
    · 「选择空间」显示目录末段名（workspaces），和项目名对不上。
  用户看到的就是一堆看不懂的层级，而不是「一个一个的项目」。

迁移动作（幂等，可重复跑；只移动不删除）：
  1. 在 workspaces 下建立「以项目名命名」的文件夹；
  2. 把项目内容（assets/、画布 *.json 及其 .bak）移动进去；
     画布里的素材是**相对路径**（assets/…），整体搬移后引用依然成立；
  3. 改写 settings.json 里的项目目录指向新文件夹。
  其他目录（_before-migrate、历史项目残留）留在原处，之后不再出现在界面里。

用法：
  python scripts/migrate-project-layout.py [--dry-run]
"""
import argparse
import json
import os
import shutil
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"

INSTANCES = [
    ("绿色版", os.path.join(BASE, "JinyuTV-portable")),
    ("安装版", os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")),
]

# 只搬这些（保守）：素材仓库 + 画布文件。
# 不碰其他目录，避免把历史项目/备份混进来。
MOVE_DIRS = ["assets"]
MOVE_SUFFIX = (".json", ".json.bak")


def same_path(left, right):
    if not left or not right:
        return False
    norm = lambda p: os.path.normcase(os.path.normpath(p.replace("/", "\\")))
    return norm(left) == norm(right)


def migrate(tag, base, dry_run):
    print("\n" + "=" * 16, tag, base)
    settings_path = os.path.join(base, "data", "settings.json")
    ws_root = os.path.join(base, "data", "workspaces")
    if not os.path.isfile(settings_path):
        print("  (无 settings.json，跳过)")
        return
    if not os.path.isdir(ws_root):
        print("  (无 workspaces 目录，跳过)")
        return

    with open(settings_path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    settings = cfg.setdefault("settings", {})
    stores = settings.setdefault("stores", {})
    store = stores.get("toonflow.projectList")
    if not isinstance(store, dict):
        print("  (无项目记录，由启动器注入默认项目，跳过)")
        return

    changed = False
    for key in ("project", "projectList"):
        records = store.get(key)
        items = records if isinstance(records, list) else ([records] if isinstance(records, dict) else [])
        for item in items:
            if not isinstance(item, dict):
                continue
            directory = item.get("directory")
            if not directory or not same_path(directory, ws_root):
                continue  # 只处理「指向 workspaces 根」的旧记录
            name = (item.get("name") or "").strip() or "我的项目"
            target = os.path.join(ws_root, name)

            print("  项目「%s」：%s" % (name, directory))
            print("            -> %s" % target)
            if dry_run:
                changed = True
                continue

            os.makedirs(target, exist_ok=True)
            # 搬素材目录
            for d in MOVE_DIRS:
                src = os.path.join(ws_root, d)
                dst = os.path.join(target, d)
                if os.path.isdir(src):
                    if os.path.exists(dst):
                        print("     ! 目标已存在 %s，跳过（未覆盖）" % d)
                    else:
                        shutil.move(src, dst)
                        print("     + 移动 %s/" % d)
            # 搬画布文件
            for entry in sorted(os.listdir(ws_root)):
                path = os.path.join(ws_root, entry)
                if os.path.isfile(path) and entry.endswith(MOVE_SUFFIX):
                    dst = os.path.join(target, entry)
                    if os.path.exists(dst):
                        print("     ! 目标已存在 %s，跳过" % entry)
                    else:
                        shutil.move(path, dst)
                        print("     + 移动 %s" % entry)

            item["directory"] = target
            changed = True

    if changed and not dry_run:
        with open(settings_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        print("  ✓ settings.json 已更新")
    elif changed:
        print("  (dry-run，未写盘)")
    else:
        print("  无需迁移（项目目录已不在 workspaces 根）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for tag, base in INSTANCES:
        if os.path.isdir(base):
            migrate(tag, base, args.dry_run)
        else:
            print("\n" + "=" * 16, tag, "(目录不存在，跳过)")
    if args.dry_run:
        print("\n[dry-run] 未做任何改动")
    return 0


if __name__ == "__main__":
    sys.exit(main())
