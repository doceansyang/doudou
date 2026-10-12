# -*- coding: utf-8 -*-
"""给「早先装的、与市场的 identifier 对不上」的技能补来源记录，让 market 列表能认出它们已安装。

机制：从市场 URL 安装时，服务端在技能目录里落下 `.toonflowMarket.json`（记 identifier），
`/api/skills/get` 把它作为 marketIdentifier 返回，前端据此判定"已安装"。早先装的没有这条记录。

⚠️ 安全闸门（照旧，用户的数据目录不能出事）：
  1. **先比对内容**：只有「解压后的每个文件与本机已装的同 sha256」才允许重装 —— 内容一致
     意味着重装是幂等的、不会覆盖用户的任何修改；不一致就跳过并报告，绝不硬来。
  2. 走应用自己的接口 `POST /api/skills/install`（force=true），不手工写 data 目录。
  3. 重装后再逐文件比对一次，确认正文一个字节都没变，只多出一个来源文件。

跑完会打印「市场 8 个插件按前端同款逻辑的判定结果」。
"""
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

DATA = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data"
SETTINGS = os.path.join(DATA, "settings.json")
SKILLS = os.path.join(DATA, "skills")
BASE = "http://127.0.0.1:3000"
MARKET_FILE = ".toonflowMarket.json"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HEADERS = {"Content-Type": "application/json", "x-toonflow-workspace": "1", "Origin": BASE}

failures = 0


def check(label, ok, detail=""):
    global failures
    print(f"  {'✓' if ok else '✗'} {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures += 1


def call(url, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"), headers=HEADERS)
    try:
        with OPENER.open(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:300]}


def wantify(value):
    """抹掉空格 / NBSP —— 上游 identifier 里混过 U+00A0。"""
    return re.sub(r"[\s\u00a0\u3000]+", "", str(value))


def unpacked_files(raw, suffix):
    """把下载到的包解开，返回 {相对路径: bytes}（与 installSkill 的关注点一致）。"""
    if suffix == ".zip":
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            return {name: zf.read(name) for name in zf.namelist() if not name.endswith("/")}
    return {"SKILL.md": raw}


def local_tree():
    """本机技能目录的逐文件 sha256（忽略 .toonflow* 系统文件）。"""
    out = {}
    for name in os.listdir(SKILLS):
        root = os.path.join(SKILLS, name)
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for file in files:
                if file.startswith(".toonflow"):
                    continue
                path = os.path.join(dirpath, file)
                rel = f"{name}/" + os.path.relpath(path, root).replace("\\", "/")
                out[rel] = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return out


def body_digest(text):
    """SKILL.md 去掉前言围栏后算摘要 —— 前言可能被服务端补全过，正文才是内容本身。"""
    stripped = re.sub(r"^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n", "", text)
    return hashlib.sha256(stripped.strip().encode("utf-8")).hexdigest()


settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
key = (settings.get("pluginMarketApiKey") or "").strip()
if not key:
    sys.exit("settings.json 里没有 pluginMarketApiKey")

req = urllib.request.Request(
    "https://api.toonflow.net/v1/plugin/getPlugin",
    data=json.dumps({"page": 1, "limit": 50, "type": "all"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
)
with OPENER.open(req, timeout=60) as r:
    items = json.loads(r.read().decode())["data"]["list"]

status, listing = call(f"{BASE}/api/skills/get")
installed = (listing.get("data") or []) if status == 200 else []
print(f"本机技能：{[x['name'] for x in installed]}\n")

# ── 逐个处理还没带来源记录的技能 ───────────────────────────────────────────
for item in [x for x in items if x.get("type") == "skill"]:
    identifier = str(item["identifier"]).strip()
    print(f"=== {identifier} ===")
    suffix = os.path.splitext(str(item.get("fileName")))[1].lower()
    with OPENER.open(item["link"], timeout=120) as resp:
        raw = resp.read()
    package = unpacked_files(raw, suffix)
    # installSkill 的资源路径是相对 SKILL.md 所在目录的，这里照搬同一套减法。
    manifest_entry = next(name for name in package if name.endswith("SKILL.md"))
    package = {os.path.relpath(name, os.path.dirname(manifest_entry)).replace("\\", "/"): content for name, content in package.items()}
    manifest = package.get("SKILL.md")
    if manifest is None:
        print("  ✗ 包里没有 SKILL.md，跳过")
        failures += 1
        continue
    # 上面用「正文摘要」而不是文件名去找，是因为包里的名字才是权威标识
    wanted = body_digest(manifest.decode("utf-8", errors="replace"))
    tree = local_tree()
    target = None
    for name in sorted({p.split("/")[0] for p in tree}):
        for rel, digest in tree.items():
            if not rel.startswith(f"{name}/"):
                continue
            if not rel.endswith("SKILL.md"):
                continue
            path = os.path.join(SKILLS, name, "/".join(rel.split("/")[1:]))
            if body_digest(open(path, encoding="utf-8", errors="replace").read()) == wanted:
                target = name
                break
        if target:
            break
    if not target:
        print("  · 本机没有同内容的版本（未安装），跳过")
        continue

    provenance = os.path.join(SKILLS, target, MARKET_FILE)
    existing = None
    if os.path.isfile(provenance):
        existing = (json.load(open(provenance, encoding="utf-8")) or {}).get("identifier")
    print(f"  对应本机技能目录：{target}   现有来源记录：{existing!r}")
    if existing and wantify(existing) == wantify(identifier):
        print("  ✓ 来源记录已正确，无需处理")
        continue

    # 安全闸门：包内每个文件都必须与本机已装的逐字节一致，否则不碰。
    before = local_tree()
    mismatched = []
    for rel, content in package.items():
        local_rel = f"{target}/{rel}"
        if local_rel not in before:
            mismatched.append(f"缺 {local_rel}")
            continue
        if rel.endswith("SKILL.md"):
            local_path = os.path.join(SKILLS, *local_rel.split("/"))
            if body_digest(open(local_path, encoding="utf-8", errors="replace").read()) != body_digest(content.decode("utf-8", errors="replace")):
                mismatched.append(f"正文不同 {local_rel}")
            continue
        if before[local_rel] != hashlib.sha256(content).hexdigest():
            mismatched.append(f"内容不同 {local_rel}")
    if mismatched:
        print(f"  ✗ 内容与本机不一致，**拒绝覆盖**（保持用户数据原样）：{mismatched}")
        failures += 1
        continue
    print("  ✓ 内容与本机完全一致 → 可以安全重装（幂等）")

    status, body = call(f"{BASE}/api/skills/install",
                        {"url": str(item["link"]), "fileName": str(item["fileName"]), "force": True})
    check("重装返回 200", status == 200, f"HTTP {status} {json.dumps(body, ensure_ascii=False)[:160]}")
    if status != 200:
        continue
    after = local_tree()
    changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    lost = sorted(set(before) - set(after))
    check("原有文件一个没少、一个没变", not changed and not lost, f"变了 {changed} / 丢了 {lost}")
    stored = json.load(open(provenance, encoding="utf-8")) if os.path.isfile(provenance) else {}
    check("来源记录已写入且 identifier 正确", wantify(stored.get("identifier", "")) == wantify(identifier), json.dumps(stored, ensure_ascii=False))
    print()

# ── 收尾：按前端同款逻辑复核整个市场列表 ──────────────────────────────────
print("=== 前端判定复核（`插件名/来源` 能否命中已安装）===")
status, listing = call(f"{BASE}/api/skills/get")
installed = (listing.get("data") or []) if status == 200 else []
all_installed = {}
for kind, path in (("node", "nodes"), ("tool", "tools"), ("skill", "skills")):
    status, response = call(f"{BASE}/api/{path}/get")
    payload = (response.get("data") or {}) if status == 200 else {}
    entries = payload.get("tools") if kind == "tool" else payload if isinstance(payload, list) else []
    for entry in entries:
        all_installed[(kind, wantify(entry.get("name")))] = entry

def lookup(type_, identifier):
    direct = all_installed.get((type_, wantify(identifier)))
    if direct:
        return direct, "按名字"
    for entry in installed:
        if entry.get("type", "skill") == type_ and wantify(entry.get("marketIdentifier", "")) == wantify(identifier):
            return entry, "按来源"
    return None, ""

for item in items:
    type_ = item.get("type")
    identifier = str(item.get("identifier"))
    if type_ == "skill":
        hit, how = lookup("skill", identifier)
    else:
        hit, how = lookup(type_, identifier)
    ok = hit is not None
    if not ok:
        failures += 1
    print(f"  {'✓' if ok else '✗'} [{type_:5s}] {identifier[:56]:56s} {'已安装（' + how + '）' if ok else '仍显示「安装」'}")

print("\n结论：" + ("全部通过" if not failures else f"{failures} 项未通过"))
sys.exit(1 if failures else 0)
