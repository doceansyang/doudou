# -*- coding: utf-8 -*-
"""JinyuTV 出厂自检 —— 封包前跑一遍，逐项给证据（不是"看起来没问题"）。

用法：
    python scripts/selfcheck.py            # 起服后自检
    python scripts/selfcheck.py --json     # 只输出 JSON（给脚本用）

为什么要有它：这轮修的都是"看起来好了、其实没生效"的坑（供应商残留、
cookie 会话化、模型源 400、圆钮椭圆）。一张 PASS/FAIL 清单比肉眼可靠。
"""
import json
import os
import re
import socket
import sys
import urllib.request

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
PORTABLE = os.path.join(BASE, "JinyuTV-portable")
INSTALLED = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")

# ⚠️ 本机装着系统代理（7897）：不绕开的话 localhost 请求会被代理转发，
#    应用没在跑时拿到的是**代理的 502**（正文 `upstream connect failed … os error 10061`），
#    会被误当成"应用报错"。所以自检一律用无代理 opener。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

RESULTS = []
NOTES = []
RETIRED = ("apiMart.ts", "metaso.ts", "tfRouter.ts", "deepSeek.ts")


def check(name, ok, detail=""):
    RESULTS.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  %s %-46s %s" % ("✅" if ok else "❌", name, detail))[:200])


def info(name, detail=""):
    """不判失败的提示项（例如"出厂后首次使用时才会有的东西"）。"""
    NOTES.append("%s：%s" % (name, detail))
    print(("  ℹ️ %-46s %s" % (name, detail))[:200])


def head(title):
    print("\n=== %s ===" % title)


def http(url, timeout=20):
    try:
        with OPENER.open(url, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, body
    except urllib.error.HTTPError as err:
        return err.code, err.read()
    except Exception as error:  # noqa: BLE001
        return 0, str(error).encode()


def port_listening(port):
    with socket.socket() as sock:
        sock.settimeout(1.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except Exception:  # noqa: BLE001
        return ""


# ----------------------------------------------------------------- 1. 进程 / 端口
head("1. 服务端口")
for port, label in ((3000, "主服务"), (18077, "豆包账号服务(RPA)")):
    check("%s 端口 %d 在监听" % (label, port), port_listening(port))

# ----------------------------------------------------------------- 2. 主服务接口
head("2. 主服务接口")
status, body = http("http://127.0.0.1:3000/")
check("主服务首页 HTTP 200", status == 200, "HTTP %s" % status)

status, body = http("http://127.0.0.1:3000/api/workspaces/list")
check("工作区接口可用", status == 200 and b"absolutePath" in body, "HTTP %s" % status)

status, body = http("http://127.0.0.1:3000/api/providers/media/list")
text = body.decode("utf-8", "replace")
try:
    payload = json.loads(text)
    providers = payload.get("data") if isinstance(payload.get("data"), list) else payload
    provider_ids = sorted(p.get("id") for p in providers if isinstance(p, dict) and p.get("id"))
    models = sorted({m.get("id") for p in providers if isinstance(p, dict) for m in (p.get("models") or []) if isinstance(m, dict)})
except Exception as error:  # noqa: BLE001
    provider_ids, models = [], []
    check("解析供应商列表", False, str(error)[:120])
check("媒体供应商只剩 Linke + 豆包账号", provider_ids == ["JinyuDream", "doubaoAccount"], "得到 %s" % provider_ids)
print("    它们带的模型：%s" % (", ".join(models[:12]) + ("…" if len(models) > 12 else "")))
check("供应商列表里没有已下线条目", not any(k in text for k in ("apiMart", "metaso", "秘塔", "deepSeek", "tfRouter")),
      "（模型名不算：gpt-image-2 / wan3 / seedance 等都是 Linke 网关提供的）")

MODEL_URL = ("http://127.0.0.1:3000/api/modelSource/v1/models/"
             "onnx-community/depth-anything-v2/small/repo?Revision=master&FilePath=config.json")
status, body = http(MODEL_URL, timeout=60)
check("模型源代理（深度动捕那种形状）HTTP 200", status == 200, "HTTP %s %s" % (status, body[:60]))

# ----------------------------------------------------------------- 3. 豆包账号服务
head("3. 豆包账号服务")
status, body = http("http://127.0.0.1:18077/health")
check("RPA /health ok", status == 200 and b"ok" in body, body[:80].decode("utf-8", "replace"))

status, body = http("http://127.0.0.1:18077/accounts")
try:
    accounts = json.loads(body.decode("utf-8")).get("accounts", [])
    print("    账号池 %d 个：%s" % (
        len(accounts),
        "; ".join("%s(登录=%s)" % (a.get("name"), a.get("hasLoggedIn")) for a in accounts) or "（空）"))
except Exception:  # noqa: BLE001
    accounts = []
    check("RPA /accounts 可读", False, body[:120].decode("utf-8", "replace"))

status, body = http("http://127.0.0.1:18077/browsers")
try:
    scanners = json.loads(body.decode("utf-8")).get("browsers", [])
    print("    扫到浏览器 %d 个：%s" % (
        len(scanners), "; ".join("%s(占用=%s/豆包=%s)" % (b.get("name"), b.get("running"), b.get("hasDoubao")) for b in scanners)))
    check("浏览器扫描可用（一键同步的前提）", len(scanners) > 0)
except Exception:  # noqa: BLE001
    check("浏览器扫描可用（一键同步的前提）", False, body[:120].decode("utf-8", "replace"))

# ----------------------------------------------------------------- 4. 供应商文件（四个位置都不该有残留）
head("4. 供应商文件 / 残留")
for root, label in ((INSTALLED, "安装版"), (PORTABLE, "便携版"), (PROJECT, "仓库")):
    for rel in ("data/providers", "build/providers"):
        directory = os.path.join(root, rel)
        if not os.path.isdir(directory):
            continue
        names = []
        for base, _dirs, files in os.walk(directory):
            names += files
        bad = [n for n in names if n in RETIRED or ".orig" in n or ".bak" in n or ".before-" in n]
        check("%s %s 无已下线/备份文件" % (label, rel), not bad, "多余：%s" % bad if bad else "共 %d 个" % len(names))
        if names:
            check("%s %s 含 Linke 适配器" % (label, rel), any(n.startswith("JinyuDream.ts") for n in names), str(sorted(names)))

# ----------------------------------------------------------------- 5. 设置（密钥别被清空）
head("5. 设置")
settings_path = os.path.join(INSTALLED, "data", "settings.json")
try:
    settings = json.loads(read(settings_path))["settings"]
    providers = settings.get("customProviders", [])
    linke = [p for p in providers if p.get("id") == "JinyuDream"]
    key_len = len((linke[0].get("apiKey") or "")) if linke else 0
    check("Linke 供应商存在且 API Key 非空", bool(linke) and key_len > 0, "id=%s key_len=%d" % (linke[0].get("id") if linke else "-", key_len))
    check("供应商 id 与适配器文件名一致（大写 JinyuDream）", bool(linke) and linke[0].get("id") == "JinyuDream")
    toapis = ((settings.get("mediaProviderConfigs") or {}).get("JinyuDream") or {}).get("uploadApiKey") or ""
    check("媒体上传 Key（toapis）非空", len(toapis) > 0, "len=%d" % len(toapis))
except Exception as error:  # noqa: BLE001
    check("读取 settings.json", False, str(error)[:120])

# ----------------------------------------------------------------- 6. 节点
head("6. 节点")
nodes_dir = os.path.join(INSTALLED, "data", "nodes")
node_files = sorted(f for f in os.listdir(nodes_dir) if f.endswith(".umd.js")) if os.path.isdir(nodes_dir) else []
check("已安装节点 >= 8 个", len(node_files) >= 8, "%d 个：%s" % (len(node_files), ", ".join(n[:-7] for n in node_files)))
check("深度动捕节点在", any("depthCapture" in n for n in node_files))
for want in ("imageGenerationNode", "videoGenerationNode"):
    content = read(os.path.join(nodes_dir, want + ".umd.js")) if os.path.isdir(nodes_dir) else ""
    check("%s 含「撤销匹配」" % want, "撤销匹配" in content)
    check("%s 含音频参考图标（合成图）" % want, "data:image/svg+xml" in content)

# ----------------------------------------------------------------- 7. 前端产物（新 UI 是否真的进了包）
head("7. 前端产物")
assets_dir = os.path.join(INSTALLED, "build", "web", "assets")
assets = [read(os.path.join(assets_dir, f)) for f in os.listdir(assets_dir)] if os.path.isdir(assets_dir) else []
blob = "\n".join(assets)
check("账号浮窗（accountPanel）在产物里", "accountPanel" in blob)
check("圆钮已钉成正方（aspect-ratio）", "aspect-ratio" in blob)
check("首屏「选浏览器同步」（pickerRow）在产物里", "pickerRow" in blob)
check("产物里没有已下线的供应商名", not any(k in blob for k in ("apiMart", "metaso", "秘塔", "deepSeek")))

# ----------------------------------------------------------------- 8. 服务端产物 / RPA 脚本
head("8. 服务端与 RPA")
server_js = read(os.path.join(INSTALLED, "build", "server", "index.js"))
check("服务端含「已下线供应商」清理逻辑", "metaso.ts" in server_js and "apiMart.ts" in server_js)
core_ts = read(os.path.join(INSTALLED, "scripts", "doubao-rpa-core.ts"))
check("RPA：cookie 补默认过期（COOKIE_TTL_SECONDS）", "COOKIE_TTL_SECONDS" in core_ts)
check("RPA：账号绑定内核（executableOverride）", "executableOverride" in core_ts)
accounts_ts = read(os.path.join(INSTALLED, "scripts", "doubao-accounts.ts"))
check("RPA：账号记录带 browser 字段", "browser" in accounts_ts)

# ----------------------------------------------------------------- 9. 启动器 / 图标 / 运行时
head("9. 启动器 / 图标 / 运行时")
for name in ("JinyuTV.exe", "logo.ico", "logo.png", "package.json", "启动JinyuTV.bat"):
    check("存在 %s" % name, os.path.exists(os.path.join(INSTALLED, name)))

# ffmpeg 不是随包发的：`packages/ffmpeg` 在首次用到时按平台下载到 data/ffmpeg/<platform>/
# （catalog 里配了 cdn.npmmirror + 一堆 gh 代理兜底）。所以"没有"不算故障。
ffmpeg_hits = []
for base, _dirs, files in os.walk(os.path.join(INSTALLED, "data", "ffmpeg")):
    ffmpeg_hits += [f for f in files if f.startswith("ffmpeg")]
if ffmpeg_hits:
    check("ffmpeg 已就位（data/ffmpeg）", True, ", ".join(sorted(ffmpeg_hits)))
else:
    info("ffmpeg", "尚未下载（首次生成/剪辑时按 platform 自动下载，catalog 已配多镜像）")

check("内置 Python 运行时在", os.path.isdir(os.path.join(INSTALLED, "data", "python")))

# ----------------------------------------------------------------- 10. 封包前的安装包暂存目录
head("10. 安装包暂存目录（真正发给客户的内容）")
STAGE = os.path.join(BASE, "_installer-stage")
check("暂存目录存在", os.path.isdir(STAGE))
if os.path.isdir(STAGE):
    check("出厂不含授权文件（license.json）", not os.path.exists(os.path.join(STAGE, "data", "license.json")))
    check("出厂不含豆包账号", read(os.path.join(STAGE, "data", "doubao", "accounts.json")).strip() in ("", "[]"))
    check("出厂不含个人画布", not any(os.scandir(os.path.join(STAGE, "data", "workspaces"))) if os.path.isdir(os.path.join(STAGE, "data", "workspaces")) else True)

    junk = []
    for rel in ("data", "build", "scripts", "tools"):
        for base, _dirs, files in os.walk(os.path.join(STAGE, rel)) if os.path.isdir(os.path.join(STAGE, rel)) else []:
            junk += [os.path.join(base, f) for f in files
                     if ".orig" in f or ".bak" in f or ".pre-" in f or ".before-" in f]
    check("暂存目录无备份/垃圾文件", not junk, "多余 %d 个" % len(junk) if junk else "")

    stage_providers = []
    for rel in ("data/providers", "build/providers"):
        directory = os.path.join(STAGE, rel)
        for base, _dirs, files in os.walk(directory) if os.path.isdir(directory) else []:
            stage_providers += files
    check("暂存目录供应商已清净", not any(f in RETIRED for f in stage_providers), str(sorted(set(stage_providers))))

    setup = sorted(f for f in os.listdir(BASE) if f.endswith("-Setup.exe"))
    check("安装包产物存在", bool(setup), ", ".join(setup[-3:]))

# ----------------------------------------------------------------- 汇总
total = len(RESULTS)
failed = [r for r in RESULTS if not r["ok"]]
print("\n" + "=" * 60)
print("自检结果：%d 项，通过 %d，失败 %d" % (total, total - len(failed), len(failed)))
if NOTES:
    print("提示（不算失败）：")
    for note in NOTES:
        print("  ℹ️ %s" % note)
if failed:
    print("失败的项：")
    for item in failed:
        print("  ❌ %s  %s" % (item["name"], item["detail"][:160]))
else:
    print("全部通过 ✅ 可以封包。")
if failed:
    print("失败的项：")
    for item in failed:
        print("  ❌ %s  %s" % (item["name"], item["detail"][:160]))
else:
    print("全部通过 ✅ 可以封包。")

if "--json" in sys.argv:
    with open(os.path.join(PROJECT, "scripts", "_out", "_selfcheck.json"), "w", encoding="utf-8") as handle:
        json.dump({"total": total, "failed": failed, "items": RESULTS}, handle, ensure_ascii=False, indent=2)

sys.exit(1 if failed else 0)
