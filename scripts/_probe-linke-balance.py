# -*- coding: utf-8 -*-
"""验证「账户余额」这条新链路：/api/linke/balance 与 /api/linke/session。

判据（都不需要真的登录 linke）：
  ① 没存过凭据时，/balance 必须回 `{ok:false, reason:"no-token"}`；
  ② 拿一把**假令牌**打 /session，必须回 `{ok:false, reason:"token-rejected"}`，
     且**不落脏数据**（settings.linkeSession 里不能出现 token）；
  ③ 上游确实被调到了（服务端日志里能看到 `/api/user/self` 的 401 留痕）。
运行：python scripts/_probe-linke-balance.py
"""
import json, os, subprocess, sys, urllib.request

API = "http://127.0.0.1:3000/api/linke"
SETTINGS = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data\settings.json"
LOG = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\logs\server.log"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 绕开系统代理


def call(path, payload=None, method="GET"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "Content-Type": "application/json", "x-toonflow-workspace": "1"})
    with OPENER.open(req, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode())


def read_settings():
    with open(SETTINGS, encoding="utf-8") as fh:
        return json.load(fh).get("settings", {})


def log_tail(keyword, limit=3):
    try:
        with open(LOG, "rb") as fh:      # 别人在写，别用独占读
            text = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    return [line for line in text.splitlines() if keyword in line][-limit:]


failures = 0
def check(label, ok, detail=""):
    global failures
    print(f"  {'✓' if ok else '✗'} {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures += 1


print("=== ① 未登录时的余额读取 ===")
status, body = call("/balance")
payload = body.get("data") or {}
check("HTTP 200 且 ok=false", status == 200 and payload.get("ok") is False, f"reason={payload.get('reason')}")
check("原因是 no-token", payload.get("reason") == "no-token")

print("\n=== ② 假令牌必须被拒、且不留脏数据 ===")
status, body = call("/session", {"payload": {"access_token": "sk-this-is-not-a-real-access-token"}}, "POST")
payload = body.get("data") or {}
check("HTTP 200 且 ok=false", status == 200 and payload.get("ok") is False, f"reason={payload.get('reason')}")
check("原因是 token-rejected", payload.get("reason") == "token-rejected")
stored = (read_settings().get("linkeSession") or {})
check("settings 里没有落下 token", not stored.get("token"), json.dumps(stored, ensure_ascii=False))

print("\n=== ③ 上游确实被调到了（服务端留痕）===")
hits = log_tail("/api/user/self")
for line in hits:
    print("    " + line.strip()[:160])
check("日志里有 /api/user/self 的记录", bool(hits))

print("\n=== ④ 退出登录 ===")
status, body = call("/session", None, "DELETE")
check("清除成功", status == 200 and (body.get("data") or {}).get("ok") is True)

print("\n结论：" + ("全部通过" if not failures else f"{failures} 项未通过"))
sys.exit(1 if failures else 0)
