# -*- coding: utf-8 -*-
"""把 Toonflow 插件市场里的**全部**插件过一遍，逐个试着下载，看是不是都能拿到。

判据：
  · 列表：分页拉全（按 type=all），看 total 与实际拿到的是否一致；
  · 下载：对每个 `link` 发一次带 Range 的 GET —— 拿到 200/206 就算"能下载"，
    只读前 2KB 就断开（不真下整包，省时间也不占流量）；
  · 顺带记下：哪些需要签名（去签名就 403）、签名里的有效期字段是什么。

运行：python scripts/_probe-market-plugins.py
"""
import json, re, sys, urllib.error, urllib.request

SETTINGS = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data\settings.json"
BASE = "https://api.toonflow.net"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
KEY = (settings.get("pluginMarketApiKey") or "").strip()
if not KEY:
    sys.exit("没有市场 key（设置 → 插件市场 里填一把），无法列举插件")


def market(body):
    req = urllib.request.Request(f"{BASE}/v1/plugin/getPlugin", data=json.dumps(body).encode(),
                                method="POST", headers={"Content-Type": "application/json",
                                                        "Authorization": "Bearer " + KEY})
    with OPENER.open(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


# ── 1. 分页拉全 ─────────────────────────────────────────────────────────
items, page, total = [], 1, None
while True:
    payload = market({"page": page, "limit": 50, "type": "all"}).get("data") or {}
    chunk = payload.get("list") or []
    total = payload.get("total")
    items.extend(chunk)
    if not chunk or (isinstance(total, int) and len(items) >= total):
        break
    page += 1
    if page > 20:
        break

print(f"市场共 {total} 个插件，本次拉到 {len(items)} 个\n")


# ── 2. 逐个试着下载 ─────────────────────────────────────────────────────
def probe(url):
    try:
        req = urllib.request.Request(url, headers={"Range": "bytes=0-2047"})
        with OPENER.open(req, timeout=30) as resp:
            head = resp.read(2048)
            size = resp.headers.get("Content-Range") or resp.headers.get("Content-Length") or "?"
            return resp.status, len(head), str(size)
    except urllib.error.HTTPError as e:
        return e.code, 0, e.read()[:80].decode("utf-8", "replace")
    except Exception as e:
        return 0, 0, f"{type(e).__name__}: {e}"


ok, bad = [], []
for it in items:
    status, got, note = probe(it.get("link"))
    mark = "✓" if status in (200, 206) else "✗"
    line = f"  {mark} [{it.get('type','?'):6s}] {str(it.get('identifier'))[:34]:34s} v{str(it.get('version','?')):8s} HTTP {status} {note}"
    (ok if status in (200, 206) else bad).append(line)
    print(line)

print(f"\n可下载 {len(ok)} / {len(items)}")
if bad:
    print("失败的：")
    for line in bad:
        print(line)

# ── 3. 签名有效期线索 ───────────────────────────────────────────────────
if items:
    q = str(items[0].get("link", "")).split("?", 1)[-1]
    pairs = dict(re.findall(r"([^&=]+)=([^&]*)", q))
    print("\n第一个链接的签名参数：", json.dumps(pairs, ensure_ascii=False)[:400])
    if "X-Tos-Date" in pairs and "X-Tos-Expires" in pairs:
        print(f"  ⇒ 签名时间 {pairs['X-Tos-Date']}，有效期 {pairs['X-Tos-Expires']} 秒（会过期，别存死链）")
