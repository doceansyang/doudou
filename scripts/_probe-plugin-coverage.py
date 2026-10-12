# -*- coding: utf-8 -*-
"""只读盘点：市场清单 vs 本机已装（不写任何东西，不改任何文件）。"""
import json
import os
import re
import sys
import urllib.request

DATA = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data"
SETTINGS = os.path.join(DATA, "settings.json")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
KINDS = {"node": "nodes", "tool": "tools", "skill": "skills", "ext": "ext", "agent": "agents"}

settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
key = (settings.get("pluginMarketApiKey") or "").strip()
if not key:
    sys.exit("settings.json 里没有 pluginMarketApiKey")
print(f"市场 key：{key[:12]}…")

req = urllib.request.Request(
    "https://api.toonflow.net/v1/plugin/getPlugin",
    data=json.dumps({"page": 1, "limit": 50, "type": "all"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
)
with OPENER.open(req, timeout=60) as r:
    payload = json.loads(r.read().decode())
items = payload["data"]["list"]
print(f"市场共 {len(items)} 个插件\n")


def snap():
    out = {}
    for kind, folder in KINDS.items():
        root = os.path.join(DATA, folder)
        if not os.path.isdir(root):
            continue
        for dirpath, _d, files in os.walk(root):
            for n in files:
                p = os.path.join(dirpath, n)
                out.setdefault(folder, []).append(os.path.relpath(p, root).replace("\\", "/"))
    return out


def norm(t):
    return re.sub(r"[^a-z0-9]", "", str(t).lower())


local = snap()
print("=== 本机已装目录 ===")
for folder in KINDS.values():
    entries = local.get(folder, [])
    top = sorted({e.split("/")[0] for e in entries})
    print(f"  {folder:8s} {len(entries):4d} 文件  {top}")

print("\n=== 逐个比对 ===")
missing = []
for it in items:
    kind = it.get("type")
    folder = KINDS.get(kind)
    if not folder:
        print(f"  ? {it['identifier']} 未知类型 {kind}")
        continue
    entries = local.get(folder, [])
    hit = False
    if kind in ("node", "tool", "ext"):
        hit = str(it.get("fileName")) in entries
    else:
        ident = norm(it.get("identifier"))
        hit = bool(ident) and any(ident in norm(e) for e in entries)
    print(f"  {'已装 ' if hit else '【缺】'} [{kind:5s}] {it['identifier']:44s} fileName={it.get('fileName')} v{it.get('version')}")
    if not hit:
        missing.append(it)

print(f"\n缺失 {len(missing)} 个：")
for it in missing:
    print(f"  - [{it['type']}] {it['identifier']}  name={it.get('name')!r}  fileName={it.get('fileName')}  v{it.get('version')}")
    print(f"     link={str(it.get('link'))[:120]}")
