# -*- coding: utf-8 -*-
"""只读：把市场里"看起来没装"的包下载到临时目录，解包看 SKILL.md 前言，和本机目录比对内容。

⚠️ 绝不写 data 目录；临时文件落在 scripts/_tmp-plugin-inspect/，跑完即删。
"""
import hashlib
import io
import json
import os
import re
import shutil
import sys
import urllib.request
import zipfile

DATA = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data"
SETTINGS = os.path.join(DATA, "settings.json")
TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp-plugin-inspect")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def wantify(value):
    # 上游 identifier 里混进了 U+00A0 / 全角空格之类不可见字符（实测 minimax 那个末尾是 NBSP）
    return re.sub(r"[\s\u00a0\u3000]+", "", str(value))


WANT = [wantify(x) for x in ["minimaxh3PromptWritingOptimizationInspection", "foodAestheticShortFilm"]]

settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
key = (settings.get("pluginMarketApiKey") or "").strip()
if not key:
    sys.exit("没有 pluginMarketApiKey")

req = urllib.request.Request(
    "https://api.toonflow.net/v1/plugin/getPlugin",
    data=json.dumps({"page": 1, "limit": 50, "type": "all"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
)
with OPENER.open(req, timeout=60) as r:
    items = json.loads(r.read().decode())["data"]["list"]

targets = [x for x in items if wantify(x.get("identifier")) in WANT]
print(f"命中 {len(targets)} 个待查包\n")


def frontmatter_field(text, field):
    m = re.search(rf"^{field}:\s*(.*)$", text, re.M)
    return m.group(1).strip() if m else None


def body_hash(text):
    # 去掉前言，只比正文，避免版本号差异干扰
    parts = text.split("---", 2)
    return hashlib.sha256((parts[2] if len(parts) > 2 else text).encode("utf-8")).hexdigest()[:16]


def local_skills():
    out = {}
    root = os.path.join(DATA, "skills")
    for name in os.listdir(root):
        p = os.path.join(root, name, "SKILL.md")
        if os.path.isfile(p):
            t = open(p, encoding="utf-8", errors="replace").read()
            out[name] = (frontmatter_field(t, "name"), body_hash(t))
    return out


locals_ = local_skills()
print("本机 skills：")
for name, (fn, h) in sorted(locals_.items()):
    print(f"  {name:32s} frontmatter.name={fn!r}  正文hash={h}")

shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

print()
for item in targets:
    ident = item["identifier"]
    print(f"=== {ident} ===")
    print(f"    fileName={item.get('fileName')}  市场版 v{item.get('version')}  displayName={item.get('displayName')!r}")
    link = item["link"]
    try:
        with OPENER.open(link, timeout=120) as resp:
            raw = resp.read()
        print(f"    下载 {len(raw)} 字节")
    except Exception as e:
        print(f"    ✗ 下载失败：{e}")
        continue
    dest = os.path.join(TMP, re.sub(r"[^A-Za-z0-9_-]", "_", ident))
    os.makedirs(dest, exist_ok=True)
    ext = os.path.splitext(str(item.get("fileName")))[1].lower()
    if ext == ".zip":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                zf.extractall(dest)
                names = zf.namelist()
        except Exception as e:
            print(f"    ✗ 解包失败：{e}")
            continue
    else:
        open(os.path.join(dest, "SKILL.md"), "wb").write(raw)
        names = ["SKILL.md"]
    print(f"    包内条目 {len(names)}：{names[:8]}")
    manifests = [n for n in names if n.endswith("SKILL.md")]
    print(f"    manifest：{manifests}")
    for m in manifests[:1]:
        p = os.path.join(dest, m)
        try:
            t = open(p, encoding="utf-8", errors="replace").read()
        except OSError as e:
            print(f"    ✗ 读不了 {m}：{e}")
            continue
        print(f"    frontmatter.name = {frontmatter_field(t, 'name')!r}")
        print(f"    description 前 60 = {str(frontmatter_field(t, 'description'))[:60]!r}")
        print("    ── 原文前 25 行 ──")
        for line in t.splitlines()[:25]:
            print(f"      │ {line[:150]}")
        h = body_hash(t)
        same = [k for k, v in locals_.items() if v[1] == h]
        print(f"    正文 hash={h}  与本机同内容：{same or '无'}")
    print()

shutil.rmtree(TMP, ignore_errors=True)
print("临时目录已清理")
