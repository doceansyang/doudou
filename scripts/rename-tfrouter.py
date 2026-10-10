# -*- coding: utf-8 -*-
"""把「官方供应商」的内部标识 tfRouter 全量改名为 JinyuDream。

背景（为什么必须整体改，不能只改一处）：
  tfRouter 是 provider 的**内部 id**，它同时出现在这些地方，任何一处不同步都会炸：
    · provider 定义      id: "tfRouter"           （language / media 各一份）
    · 变量名 / import 名  tfRouter, tfRouterMedia, tfRouterLanguage
    · 函数名             isTfRouterProvider()
    · 文件名             src/media/tfRouter.ts  src/language/tfRouter.ts
    · package exports     "./media/tfRouter": "./src/media/tfRouter.ts"
    · 运行时安装清单      autoInstallProviders = ["tfRouter.ts", ...]
    · 运行时配置键        settings.customProviders[].id / mediaProviderConfigs.tfRouter
    · 兼容判断            id === tfRouter.id（用于识别「旧版 provider 文件」）
  → 因此本脚本一次性替换标识符、重命名文件，并同步迁移各实例的 settings.json。

⚠️ 大小写敏感（关键）：
   本机 Windows 用户名是 JinYuDream（大写 Y），与目标名 JinyuDream（小写 i/y）**不同**。
   替换一律大小写敏感，绝不能用大小写不敏感的模式，否则会改坏 C:\\Users\\JinYuDream\\... 路径。

不改的东西：
   · label（界面上显示的供应商名）不属于本次范围，保持原值。
   · 形如 TF-Router 的**文案**此前已统一为 Linke，不在本次替换内。
   · .orig / .bak / build/ 等备份与构建产物跳过（产物重新构建即可）。

用法：
  python scripts/rename-tfrouter.py --dry-run     # 预演，只报告
  python scripts/rename-tfrouter.py --apply       # 执行（自动备份）
"""
import argparse
import json
import os
import shutil
import sys
import time

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
BACKUP = os.path.join(PROJECT, ".tfrouter-backup")

TARGET_DIRS = ["apps", "packages", "scripts", "data", "tools"]

SKIP_DIRS = {
    "node_modules", "build", "_out", ".git",
    ".rebrand-backup", ".api-rebrand-backup", ".tfrouter-backup",
    "_junk-backups", "_old-artifacts",
}
SKIP_SUFFIX = (
    ".orig", ".bak", ".bak2", ".bak3", ".prebuild", ".manual", ".empty",
    ".log", ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mp3", ".ico",
)
# 脚本自身不能改：它里面的替换表一旦被替换，规则就失效了
SKIP_FILES = {"rename-tfrouter.py"}

# 大小写敏感的有序替换。三种写法都要覆盖 —— 曾经只处理了驼峰两种，
# 漏掉全小写形式，导致 `id.toLowerCase() === "tfrouter"` 这类比较没被改到，
# 结果 provider 识别恒为 false（表现为「官方」标签消失、取不到 API Key、
# 关于页报「Linke 响应格式不正确」）。
REPLACEMENTS = [
    ("tfRouter", "JinyuDream"),
    ("TfRouter", "JinyuDream"),
    ("tfrouter", "jinyudream"),   # toLowerCase() 比较用的全小写形式
    ("tf-router", "jinyudream"),  # 少数地方的连字符写法
]

# 需要一并改名的文件（旧名 -> 新名）
RENAME_FILES = {
    "tfRouter.ts": "JinyuDream.ts",
    "checkTfRouterAudio.ts": "checkJinyuDreamAudio.ts",
}

# 各软件实例（这些不是源码，是运行数据 + 构建产物；配置需要迁移）
INSTANCES = [
    ("绿色版", os.path.join(BASE, "JinyuTV-portable")),
    ("安装版", os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")),
]


def backup(path, rel_root):
    """首次改动前留一份原文件（只留第一次，避免覆盖真正的原始版本）。"""
    rel = os.path.relpath(path, rel_root)
    dst = os.path.join(BACKUP, rel.replace("\\", "_").replace("/", "_"))
    if os.path.exists(dst):
        return
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(path, dst)
    except OSError:
        pass


def walk_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(SKIP_SUFFIX) or name in SKIP_FILES:
                continue
            yield os.path.join(dirpath, name)


def rewrite_file(path, root, apply_):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return 0
    updated = text
    for old, new in REPLACEMENTS:
        updated = updated.replace(old, new)
    if updated == text:
        return 0
    hits = sum(text.count(old) for old, _ in REPLACEMENTS)
    if apply_:
        backup(path, root)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(updated)
    return hits


def rename_files(root, apply_):
    renamed = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for old, new in RENAME_FILES.items():
            if old in filenames:
                src, dst = os.path.join(dirpath, old), os.path.join(dirpath, new)
                renamed.append((src, dst))
                if apply_ and not os.path.exists(dst):
                    backup(src, root)
                    os.rename(src, dst)
    return renamed


def migrate_settings(settings_path, apply_):
    """迁移运行时配置里的 provider id 与配置键。"""
    if not os.path.isfile(settings_path):
        return False
    with open(settings_path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    settings = cfg.get("settings") or {}
    touched = []

    providers = settings.get("customProviders")
    if isinstance(providers, list):
        for item in providers:
            if isinstance(item, dict) and item.get("id") == "tfRouter":
                item["id"] = "JinyuDream"
                touched.append("customProviders[].id")

    configs = settings.get("mediaProviderConfigs")
    if isinstance(configs, dict) and "tfRouter" in configs:
        configs["JinyuDream"] = configs.pop("tfRouter")
        touched.append("mediaProviderConfigs 键")

    if touched and apply_:
        os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
        shutil.copy2(settings_path, os.path.join(
            BACKUP, "settings-%s.json" % time.strftime("%m%d-%H%M%S")))
        with open(settings_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return bool(touched)


def migrate_instance(tag, base, apply_):
    print("\n" + "=" * 14, tag, base)
    if not os.path.isdir(base):
        print("  (目录不存在，跳过)")
        return
    print("  settings:", "已迁移 %s" % migrate_settings(
        os.path.join(base, "data", "settings.json"), apply_) if True else "")
    # 运行时 provider 文件名
    for sub in ("data/providers",):
        folder = os.path.join(base, sub.replace("/", os.sep))
        if not os.path.isdir(folder):
            continue
        for old, new in RENAME_FILES.items():
            src, dst = os.path.join(folder, old), os.path.join(folder, new)
            if os.path.isfile(src) and not os.path.exists(dst):
                print("  重命名 %s -> %s" % (old, new))
                if apply_:
                    os.rename(src, dst)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真正写盘（默认只预演）")
    args = parser.parse_args()
    apply_ = args.apply
    print("=== %s ===" % ("执行改名" if apply_ else "预演（未写盘）"))

    total, files = 0, []
    for name in TARGET_DIRS:
        root = os.path.join(PROJECT, name)
        if not os.path.isdir(root):
            continue
        for path in walk_files(root):
            hits = rewrite_file(path, PROJECT, apply_)
            if hits:
                files.append((os.path.relpath(path, PROJECT), hits))
                total += hits
    for rel, hits in sorted(files):
        print("  %-58s %d 处" % (rel, hits))
    print("  —— 源码共 %d 个文件 / %d 处" % (len(files), total))

    renamed = rename_files(PROJECT, apply_)
    print("  文件重命名：%d 个" % len(renamed))
    for src, dst in renamed:
        print("    %s -> %s" % (os.path.basename(src), os.path.basename(dst)))

    for tag, base in INSTANCES:
        migrate_instance(tag, base, apply_)

    if not apply_:
        print("\n[dry-run] 未做任何改动；确认无误后加 --apply")
    else:
        print("\n备份目录：%s" % BACKUP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
