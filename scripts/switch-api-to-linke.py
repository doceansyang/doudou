#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把各实例运行数据里的「官方供应商」切到 api.linke.link。

做两件事：
  1. settings.json 的 settings.customProviders 里 id=JinyuDream 那一项：
     apiUrl -> https://api.linke.link/v1、label -> Linke
     （服务端只在"尚未配置"时初始化，已有实例不会自动更新，所以必须显式改）
  2. 把最新的 provider 文件复制到 <实例>/data/providers/ ，避免旧的 apiUrl 还留在运行时
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # toonflow/
SRC_PROVIDERS = os.path.join(ROOT, "data", "providers")
API = "https://api.linke.link/v1"
LABEL = "Linke"

INSTANCES = [
    os.path.join(os.path.dirname(ROOT), "JinyuTV-portable"),               # 开发绿色版
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV"),  # 安装版（新品牌）
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuDream"),  # 旧品牌安装版
]


def update_settings(inst):
    path = os.path.join(inst, "data", "settings.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    providers = cfg.get("settings", {}).get("customProviders")
    if not isinstance(providers, list):
        return "无 customProviders"

    changed = []
    for item in providers:
        if not isinstance(item, dict) or str(item.get("id", "")).lower() != "tfrouter":
            continue
        if item.get("apiUrl") != API:
            changed.append("apiUrl %s -> %s" % (item.get("apiUrl"), API))
            item["apiUrl"] = API
        if item.get("label") != LABEL:
            changed.append("label %s -> %s" % (item.get("label"), LABEL))
            item["label"] = LABEL
    if not changed:
        return "已是新地址"

    if "--apply" in sys.argv:
        backup = path + ".pre-linke"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return "、".join(changed)


def sync_providers(inst):
    dst = os.path.join(inst, "data", "providers")
    if not os.path.isdir(dst) or not os.path.isdir(SRC_PROVIDERS):
        return 0
    copied = 0
    for name in os.listdir(SRC_PROVIDERS):
        if not name.endswith(".ts") or name.endswith(".orig"):
            continue
        src = os.path.join(SRC_PROVIDERS, name)
        try:
            with open(src, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        target = os.path.join(dst, name)
        # 只覆盖与本次改造相关的 provider，其它保持实例本地版本
        if name not in ("JinyuDream.ts",):
            continue
        if "--apply" in sys.argv:
            shutil.copy2(src, target)
        copied += 1
    return copied


def main():
    apply = "--apply" in sys.argv
    print("%s\n" % ("已应用" if apply else "dry-run（加 --apply 执行）"))
    for inst in INSTANCES:
        if not os.path.isdir(inst):
            continue
        name = os.path.basename(inst)
        result = update_settings(inst)
        providers = sync_providers(inst)
        print("  %s" % name)
        print("     settings.json: %s" % result)
        print("     provider 同步: %s 个文件" % providers)
    if apply:
        print("\nsettings.json 原文件备份为 *.pre-linke")


if __name__ == "__main__":
    main()
