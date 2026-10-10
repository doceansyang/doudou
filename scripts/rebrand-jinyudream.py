# -*- coding: utf-8 -*-
"""把 Toonflow 品牌改名为 JinyuTV（只动用户可见品牌与系统标识符，不动内部包名）。

严格保护（绝不替换）：
  @toonflow/*            —— workspace 包名（510 处 import）
  toonflowCanvas         —— 画布 JSON 字段（改了旧画布打不开）
  x-toonflow-*           —— HTTP 头（前后端约定）
  toonflow:*             —— 内部事件名 / 虚拟模块前缀
  toonflowNodes/NodesHost/ToolHost/ExtHost/TiptapHost/ToolClient/Exts/Attachments ...
                         —— 宿主注入对象名（node/tool/ext 三方约定）
  process.env.toonflowDesktop
  toonflow-mcp / toonflowJinyuDreamAudio 等

用法：
  python scripts/rebrand-jinyutv.py            # dry-run，只统计
  python scripts/rebrand-jinyutv.py --apply    # 实际替换（自动备份到 .rebrand-backup/）
"""
import os
import re
import shutil
import sys
from collections import Counter

ROOTS = ["apps", "packages", "build", "data"]
SKIP_DIRS = {"node_modules", ".git", ".rebrand-backup", "dist", ".cache"}
EXTS = {".ts", ".vue", ".js", ".mjs", ".cjs", ".json", ".html", ".nsi", ".nsh",
        ".cs", ".txt", ".yaml", ".yml", ".svg", ".toml", ".ini"}

BRAND = "JinyuTV"

# 受保护形态：命中则整行跳过（保守做法，宁可少改不可改错）
#   @toonflow/          workspace 包名
#   toonflow[A-Z]       驼峰内部标识符：toonflowCanvas / toonflowNodes / toonflowDesktop ...
#   toonflow:(?!//)     内部事件名与虚拟模块前缀（用负向断言放行 toonflow:// 协议）
#   x-toonflow-         内部 HTTP 头
#   toonflow-mcp        MCP 插件名
PROTECTED_PATTERNS = [
    r"@toonflow/",
    r"toonflow[A-Z]",
    r"toonflow:(?!//)",
    r"x-toonflow-",
    r"toonflow-mcp",
]
_PROTECTED_RE = [re.compile(pattern) for pattern in PROTECTED_PATTERNS]

# 可以安全改的形态：只改「裸品牌词」与明确的系统标识符
IDENT_RULES = [
    # 后顾保留 "."（避免 xxx.Toonflow 这类域名形态），前瞻只挡 ASCII 紧邻字符：
    #   句末 "open in Toonflow." 要改；真实仓库名 "HBAI-Ltd/Toonflow-app" 要留（- 后跟 ASCII 字母）；
    #   而孟加拉语 "Toonflow-এর"（- 后跟非 ASCII）要改。
    (r"(?<![A-Za-z0-9_\-./])Toonflow(?![A-Za-z0-9_/]|-[A-Za-z])", BRAND),
    (r"Software\\Classes\\toonflow\b", r"Software\\Classes\\jinyutv"),
    (r"toonflow\.ini", "jinyutv.ini"),
    (r"local\.toonflow\.desktop", "local.jinyutv.desktop"),
    (r"toonflow://", "jinyutv://"),
]

BACKUP_ROOT = ".rebrand-backup"


def protected(line: str) -> bool:
    return any(rule.search(line) for rule in _PROTECTED_RE)


def iter_files():
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".bak")]
            for name in filenames:
                if os.path.splitext(name)[1].lower() in EXTS:
                    path = os.path.join(dirpath, name)
                    if os.path.getsize(path) > 30 * 1024 * 1024:
                        continue
                    yield path


def transform(text: str, stats: Counter):
    # 不做整行跳过 —— 替换规则本身已经足够精确：
    #   大写 Toonflow 带负向断言，不会碰到标识符；@toonflow/ 是小写，天然不受影响。
    #   小写规则也都是 Software\Classes\toonflow、toonflow.ini、toonflow:// 这类精确形态。
    # 原先按行跳过会导致「与 @toonflow/ 同行的 Toonflow 文案」被整行漏改（i18n 里踩过）。
    for pattern, repl in IDENT_RULES:
        text, n = re.subn(pattern, repl, text)
        if n:
            stats[pattern] += n
    return text


def main():
    apply = "--apply" in sys.argv
    stats = Counter()
    changed_files = []
    undecodable = []

    for path in iter_files():
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except UnicodeDecodeError:
            undecodable.append(path)
            continue
        new = transform(text, stats)
        if new == text:
            continue
        changed_files.append(path)
        if apply:
            backup = os.path.join(BACKUP_ROOT, path)
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            # 只备份首次（即真正的原始版本），重复运行不得覆盖
            if not os.path.exists(backup):
                shutil.copy2(path, backup)
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(new)

    print("模式        : %s" % ("APPLY（已写入）" if apply else "DRY-RUN（未写入）"))
    print("命中文件数  : %d" % len(changed_files))
    print("替换统计    :")
    for pattern, count in stats.most_common():
        print("   %-72s %d" % (pattern[:72], count))
    print("替换总次数  : %d" % sum(stats.values()))
    if undecodable:
        print("非 UTF-8（已跳过，需人工处理）: %d" % len(undecodable))
        for path in undecodable[:10]:
            print("   %s" % path)
    if changed_files:
        print("前 15 个受影响文件：")
        for path in changed_files[:15]:
            print("   %s" % path)
    if apply:
        print("备份目录    : %s/" % BACKUP_ROOT)


if __name__ == "__main__":
    main()
