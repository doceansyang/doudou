# -*- coding: utf-8 -*-
"""把被探针误删的「插件市场密钥」写回去。

背景：`probe-plugin-market.mjs` 为了验证"请求发往哪个域"，会临时把 Linke 的 key 写进
`pluginMarketApiKey`，验证完在 finally 里 `delete` 掉这个字段 —— 于是**用户原本填的那把也被删了**。
这里从服务端读回完整设置、把字段补上、再整体写回（走 HTTP，保证内存与磁盘一致）。
"""
import json, sys, urllib.request

KEY = "sk-REMOVED-EXAMPLE"   # 用户原先填的那把（从探针输出里读到的原文）
API = "http://127.0.0.1:3000/api/settings"
# ⚠️ `/api/settings/get|save` 会校验来源（getAppOrigin）：必须带 Origin，且 host 要和请求的 Host 一致
H = {"Content-Type": "application/json", "x-toonflow-workspace": "1",
     "Origin": "http://127.0.0.1:3000"}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

with OPENER.open(urllib.request.Request(API + "/get", headers=H), timeout=20) as r:
    settings = json.loads(r.read().decode())["data"]
print("改前 pluginMarketApiKey =", repr(settings.get("pluginMarketApiKey")))
settings["pluginMarketApiKey"] = KEY
req = urllib.request.Request(API + "/save", data=json.dumps({"settings": settings}).encode(),
                             method="PUT", headers=H)
with OPENER.open(req, timeout=20) as r:
    print("保存 →", r.status)
with OPENER.open(urllib.request.Request(API + "/get", headers=H), timeout=20) as r:
    after = json.loads(r.read().decode())["data"]
print("改后 pluginMarketApiKey =", repr(after.get("pluginMarketApiKey")))
print("helloCompleted 还在吗:", after.get("helloCompleted"),
      "| 文本供应商数:", len(after.get("customProviders") or []))
