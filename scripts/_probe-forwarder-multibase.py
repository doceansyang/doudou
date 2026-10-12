# -*- coding: utf-8 -*-
"""专项回归：rewriteLinks 缓存污染（多 Host 双重改写）。
起本地 server.mjs，同一请求体用两个不同 Host 先后请求，断言：
  ① 两次 link 各自以本请求的 Host 开头（缓存命中也重写）
  ② link 里 asset 前缀只出现一次（无嵌套）
  ③ 下载走中转与直连 TOS 字节一致
"""
import json, os, socket, subprocess, sys, time, urllib.request

PORT = 18790
BASE = f"http://127.0.0.1:{PORT}"
KEY = json.load(open(r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data\settings.json", encoding="utf-8"))["settings"]["pluginMarketApiKey"]
ROOT = r"C:\Users\JinYuDream\WorkBuddy\豆包画布开发\toonflow\tools\plugin-forwarder"

env = dict(os.environ, TOONFLOW_MARKET_KEY=KEY, PORT=str(PORT), CACHE_SECONDS="30", PROXY_DOWNLOAD="1")
proc = subprocess.Popen(["C:/Users/JinYuDream/.workbuddy/binaries/node/versions/22.22.2-6/node.exe", os.path.join(ROOT, "server.mjs")], env=env)
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ok = True

try:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=1).close()
            break
        except OSError:
            time.sleep(0.2)
    else:
        print("✘ 服务未起来"); sys.exit(1)

    def ask(host_header, limit=3):
        req = urllib.request.Request(f"{BASE}/v1/plugin/getPlugin",
            data=json.dumps({"page": 1, "limit": limit, "type": "all"}).encode(), method="POST",
            headers={"Content-Type": "application/json", "Host": host_header})
        return json.loads(op.open(req, timeout=40).read().decode())["data"]["list"]

    print("① 第一个 Host（缓存冷）")
    a = ask("host-a.example")
    ok &= all(x["link"].startswith("http://host-a.example/v1/plugin/asset/") for x in a)
    ok &= all(x["link"].count("/v1/plugin/asset/") == 1 for x in a)
    print("   link 前缀正确、无嵌套:", ok)

    print("② 第二个 Host（同 key 缓存命中——旧代码在这里双重改写）")
    b = ask("host-b.example")
    b_ok = all(x["link"].startswith("http://host-b.example/v1/plugin/asset/") for x in b)
    b_ok &= all(x["link"].count("/v1/plugin/asset/") == 1 for x in b)
    b_ok &= all("host-a.example" not in x["link"] for x in b)
    print("   第二次 link 前缀正确、无嵌套、无上一家 Host 残留:", b_ok)
    ok &= b_ok

    print("③ 下载字节一致性（中转 vs 直连 TOS）")
    from urllib.parse import unquote
    src = unquote(b[0]["link"].split("src=")[1])
    proxied = op.open(b[0]["link"].replace("host-b.example", f"127.0.0.1:{PORT}"), timeout=120).read()
    direct = op.open(src, timeout=120).read()
    print(f"   中转 {len(proxied)} B / 直连 {len(direct)} B / 一致: {proxied == direct}")
    ok &= proxied == direct
finally:
    proc.terminate()

print("\n结论：", "全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
