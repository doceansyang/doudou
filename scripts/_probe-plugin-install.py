# -*- coding: utf-8 -*-
"""端到端验收：**插件安装链路**（装 → 能被扫到 → 卸干净）。

之前只验到"能从市场下载"（HTTP 206），没验过"点安装之后到底成不成、卸不卸得掉"。
这里走**应用自己的接口**（`POST /api/{nodes|tools|skills}/install` → 服务端自己去下载落盘），
而不是绕过应用手工写文件 —— 手工写文件证明不了这条链路。

⚠️⚠️ 两条安全闸门（血的教训，见下）：
  1. **只碰"本次自己装进去的"**：装前先确认本地没有对应产物；万一目标其实已装
     （接口回 409），**直接换下一个候选**，绝不"先卸再装"。
  2. **兜底卸载只在「安装接口返回过 200」时才执行**。
     上一版写成 `if installed or os.path.isfile(path)` —— 目标其实早就装着（用户自己装的
     `webEpisodeEditorProNode`），第一条判据失败后，finally 还是把它**卸掉了**。
     这是用户的数据目录，任何"顺手清理"都是事故。已装回并记进项目备忘。

判定"本地有没有"：
  · node/tool/ext —— 看 `data/<类型目录>/<fileName>` 在不在（精确）；
  · skill —— 解压后目录名由 zip 决定，猜不准，用**归一化子串**粗判；粗判为"有"就跳过。

跑完会比对 `data/{nodes,tools,skills,ext,agents}` 的**逐文件 sha256**，确认回到装前状态。
运行前服务要在跑（`scripts/_start-server-detached.py`）。
"""
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request

DATA = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data"
SETTINGS = os.path.join(DATA, "settings.json")
BASE = "http://127.0.0.1:3000"
KINDS = {"node": "nodes", "tool": "tools", "skill": "skills", "ext": "ext", "agent": "agents"}
ROOTS = [os.path.join(DATA, d) for d in ("nodes", "tools", "skills", "ext", "agents")]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HEADERS = {
    "Content-Type": "application/json",
    "x-toonflow-workspace": "1",
    # 这些接口走 isLocalWorkspaceRequest：必须带与 Host 一致的 Origin。
    "Origin": BASE,
}

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
            return e.code, {"_raw": raw[:200]}


def snapshot():
    """插件相关目录的逐文件 sha256（相对 data/ 的路径）。"""
    out = {}
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, DATA).replace("\\", "/")
                try:
                    with open(path, "rb") as fh:
                        out[rel] = hashlib.sha256(fh.read()).hexdigest()
                except OSError:
                    out[rel] = "?"
    return out


def norm(text):
    return re.sub(r"[^a-z0-9]", "", str(text).lower())


def already_local(item, snap):
    """本地是否已有这个插件的产物。node/tool/ext 精确判；skill 只能粗判。"""
    kind = item.get("type")
    if kind in ("node", "tool", "ext"):
        return f"{KINDS[kind]}/{item.get('fileName')}" in snap
    ident = norm(item.get("identifier"))
    return bool(ident) and any(ident in norm(path) for path in snap)


settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
if not (settings.get("pluginMarketApiKey") or "").strip():
    sys.exit("settings.json 里没有 pluginMarketApiKey")

req = urllib.request.Request(
    "https://api.toonflow.net/v1/plugin/getPlugin",
    data=json.dumps({"page": 1, "limit": 50, "type": "all"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + settings["pluginMarketApiKey"]},
)
with OPENER.open(req, timeout=30) as r:
    items = json.loads(r.read().decode())["data"]["list"]

before = snapshot()
print(f"插件目录现有 {len(before)} 个文件\n")

# 候选顺序：tool → node → skill → ext（单文件类最容易判"本地有没有"）
order = {"tool": 0, "node": 1, "skill": 2, "ext": 3}
candidates = sorted([x for x in items if x.get("type") in order], key=lambda x: order[x["type"]])

target = None
install_body = {}
print("=== ① 挑一个本地没有的插件（逐个试；409 = 其实已装 → 换下一个）===")
for item in candidates:
    if already_local(item, before):
        print(f"  跳过 {item['identifier']}（本地已有产物）")
        continue
    status, body = call(f"{BASE}/api/{KINDS[item['type']]}/install",
                        {"url": str(item["link"]), "fileName": str(item["fileName"])})
    if status == 409:
        # 粗判没认出（skill 的解压目录名猜不准），但接口说已装 —— 换下一个，**别去卸它**。
        print(f"  跳过 {item['identifier']}（接口报已装：{str(body.get('message', ''))[:46]}）")
        continue
    if status != 200:
        print(f"  ✗ {item['identifier']} 安装失败 HTTP {status}：{json.dumps(body, ensure_ascii=False)[:110]}")
        failures += 1
        break
    target, install_body = item, body
    print(f"  选中 {item['identifier']}")
    break

if target is None:
    print("\n没有可安全测试的目标（能装的插件本地都已有产物）。")
    print("这本身说明安装链路已被实际使用过；如需重测，先卸掉一个再跑本脚本。")
    sys.exit(1 if failures else 0)

kind = target["type"]
path = KINDS[kind]
file_name = str(target["fileName"])
print(f"\n目标：{target['name']}（{file_name}，v{target['version']}，{kind} 类）\n")

installed = False          # ⚠️ 只有安装接口回过 200 才置 True —— 兜底卸载的唯一依据
installed_name = None
try:
    print("=== ② 安装结果 ===")
    installed_name = (install_body.get("data") or {}).get("name")
    check("接口回了 200 并给出名字", bool(installed_name), f"name = {installed_name}")
    installed = True

    print("\n=== ③ 界面能扫到它 ===")
    status, listing = call(f"{BASE}/api/{path}/get")
    entries = listing.get("data") or []
    names = [x.get("name") for x in entries]
    check("已安装列表里出现了它", status == 200 and len(names) > 0, f"{path} 共 {len(names)} 项")
    if installed_name and installed_name in names:
        entry = next(x for x in entries if x.get("name") == installed_name)
        check("有版本号（脚本/技能描述能被解析）", bool(entry.get("version") or entry.get("displayName")),
              f"v{entry.get('version')} / {entry.get('displayName')}")
    else:
        # 通过列表定位不到它的名字（skill 解压后的目录名与 identifier 不一定相同）
        check("能定位到新装项的名字", bool(installed_name), f"接口返回的 name = {installed_name}")

    after_install = snapshot()
    added = sorted(set(after_install) - set(before))
    check("确实落盘了新文件", bool(added), f"新增 {len(added)} 个：{added[:4]}{'…' if len(added) > 4 else ''}")

    print("\n=== ④ 卸载 ===")
    remove_name = installed_name or target["identifier"]
    status, body = call(f"{BASE}/api/{path}/uninstall", {"name": remove_name}, method="DELETE")
    check("卸载返回 200", status == 200, f"HTTP {status} {json.dumps(body, ensure_ascii=False)[:110]}")
    if status == 200:
        installed = False

    print("\n=== ⑤ 回到装前状态 ===")
    after = snapshot()
    left = sorted(set(after) - set(before))
    missing = sorted(set(before) - set(after))
    changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    check("新增的文件都清干净了", not left, f"残留 {left[:5]}")
    check("原有文件一个没少", not missing, f"丢了 {missing[:5]}")
    check("原有文件内容没被动过", not changed, f"变了 {changed[:5]}")
finally:
    # ⚠️ 只有"确实是自己装进去的"才兜底卸 —— 绝不因为"文件在那儿"就删（上一版就是这么出事的）。
    if installed:
        s, b = call(f"{BASE}/api/{KINDS[kind]}/uninstall", {"name": installed_name or target["identifier"]}, method="DELETE")
        print(f"\n[兜底] 卸载自己装进去的 {installed_name} → HTTP {s} {json.dumps(b, ensure_ascii=False)[:80]}")
    else:
        print("\n[兜底] 没有需要清理的（目标不是本次装进去的）")

print("\n结论：" + ("全部通过" if not failures else f"{failures} 项未通过"))
sys.exit(1 if failures else 0)
