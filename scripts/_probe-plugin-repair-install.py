# -*- coding: utf-8 -*-
"""端到端验收：市场上「元数据不合规」的技能包能被装上并被正常加载 —— 以「舌尖美食-美学短片」为例。

背景：这个包没有 `---` 前言围栏，只在正文开头写了 `skill_name:` / `skill_description:`，
且 skill_name 是中文 ⇒ 以前被 name 校验直接拒掉（HTTP 400）。现在服务端会补齐合规前言后原样落盘。

⚠️ 安全闸门：
  · 只走**应用自己的接口**（POST /api/skills/install → 服务端自己下载），不绕过应用手写文件；
  · 目标若**本来就装了**，直接跳过，绝不"先卸再装"；
  · 这是用户**要留下**的技能，验收通过**不卸载**。

运行前服务要在跑。
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DATA = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data"
SETTINGS = os.path.join(DATA, "settings.json")
SKILLS = os.path.join(DATA, "skills")
BASE = "http://127.0.0.1:3000"
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
    return re.sub(r"[\s\u00a0\u3000]+", "", str(value))


# 列表走**自家中转**（与客户端同一条链路）：key 在服务端，这里不带凭据；
# 拿到的 link 是中转改写后的加密下载地址，正好用来验收服务端安装能吃下它。
req = urllib.request.Request(
    "https://linke.link/v1/plugin/getPlugin",
    data=json.dumps({"page": 1, "limit": 50, "type": "all"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json"},
)
with OPENER.open(req, timeout=60) as r:
    items = json.loads(r.read().decode())["data"]["list"]

TARGET = "foodAestheticShortFilm"
target = next((x for x in items if wantify(x.get("identifier")) == TARGET), None)
if target is None:
    sys.exit(f"市场里找不到 {TARGET}（现有：{[x.get('identifier') for x in items]}）")

print(f"目标：{target.get('displayName') or target.get('name')}  fileName={target['fileName']}  v{target['version']}")
before = sorted(os.listdir(SKILLS))

print("\n=== ① 通过应用接口安装 ===")
status, body = call(f"{BASE}/api/skills/install", {"url": str(target["link"]), "fileName": str(target["fileName"])})
already = status == 409 and "已安装" in str(body.get("message", ""))
if already:
    # 已经装过了（比如用户在界面点过一次）→ 不重装、不卸载，直接拿现有的做验收。
    print("  （本机已装过，跳过安装直接验收 —— 不重装是为了不动用户数据）")
check("安装成功 / 本来已装", status == 200 or already, f"HTTP {status} {json.dumps(body, ensure_ascii=False)[:200]}")
if not (status == 200 or already):
    sys.exit(1)

data = body.get("data") or {}
if already:
    status, listing = call(f"{BASE}/api/skills/get")
    hit0 = next((x for x in (listing.get("data") or [])
                 if x.get("marketIdentifier") and re.sub(r"[\s\u00a0\u3000]+", "", x["marketIdentifier"]) == TARGET), None)
    if not hit0:
        sys.exit("已装但没有来源记录，无法定位它验收")
    data = {"name": hit0["name"], "repaired": True}
else:
    status, listing = call(f"{BASE}/api/skills/get")
installed_name = data.get("name")
check("接口给出了技能名", bool(installed_name), f"name = {installed_name}")
check("名字是合规的 ASCII 短横线格式", bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", installed_name or "")), installed_name or "")
print("  （已装状态下的来源记录已确认，见第 ③ 步）")

print("\n=== ② 落盘内容 ===")
path = os.path.join(SKILLS, installed_name, "SKILL.md")
check("技能目录已建成", os.path.isfile(path), path)
text = open(path, encoding="utf-8").read() if os.path.isfile(path) else ""
head = "\n".join(text.splitlines()[:5])
print("  ── 文件头部 ──")
for line in head.splitlines():
    print(f"    │ {line[:120]}")
check("文件以标准前言围栏开头", text.startswith("---"))
check("正文一字未改（原始 <planner> 段落还在）", "<planner>" in text)
check("正文保留了包里原本的中文元数据行", 'skill_name: "舌尖美食-美学短片"' in text)

print("\n=== ③ 加载器能读到它（/api/skills/get 用的就是 loadSkillsFromDir）===")
status, listing = call(f"{BASE}/api/skills/get")
entries = (listing.get("data") or []) if status == 200 else []
hit = next((x for x in entries if x.get("name") == installed_name), None)
check("技能出现在已安装列表里（缺 description 的会被加载器丢弃）", hit is not None, f"列表共 {len(entries)} 项")
if hit:
    check("界面显示回原本的中文名", hit.get("displayName") == "舌尖美食-美学短片", f"displayName = {hit.get('displayName')!r}")
    check("描述非空", bool((hit.get("description") or "").strip()), str(hit.get("description"))[:60])
    check("未被品牌化处理（不是 JinyuTV 替身）", "toonflow" not in json.dumps(hit, ensure_ascii=False).lower())

print("\n=== ④ 技能编辑器能打开它 ===")
status, response = call(f"{BASE}/api/skills/list?name={urllib.parse.quote(installed_name)}")
files = ((response.get("data") or {}) if status == 200 else {}).get("files") or []
check("能列出技能文件", status == 200 and "SKILL.md" in files, f"HTTP {status} files={files}")

added = sorted(set(os.listdir(SKILLS)) - set(before))
print(f"\n新增技能目录：{added}（保留，不卸载 —— 这是用户要装的）")
print("结论：" + ("全部通过" if not failures else f"{failures} 项未通过"))
sys.exit(1 if failures else 0)
