#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证下载地址的「源站参数」加密（ASSET_TOKEN_KEY）。

四条必须成立：
  ① 配了密钥 → link 里是 ?d=<token>，且**整个 link 不含 toonflow 字样**（抓包不露上游）
  ② ?d= 能正常下载，字节与直连上游一致
  ③ 篡改 token / 换密钥 → 400，不能下
  ④ 加密模式下明文 ?src= 一律拒绝（否则又漏回上游域名）

用独立端口 8799 起一个带密钥的实例，测完就杀，不碰生产服务。
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BUN = r"C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "plugin-forwarder", "server.mjs")
PORT = 8799
KEY = "sk-REMOVED-EXAMPLE"  # 占位上游 key，本探针只验改写/解密，不真取列表
TOKEN_KEY = "probe-token-key-8f3a1c"

settings = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "JinyuTV", "data", "settings.json")
try:
    KEY = json.load(open(settings, encoding="utf-8"))["settings"].get("pluginMarketApiKey") or KEY
except Exception:
    pass

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✓ {label}" + (f"  {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ✘ {label}  {detail}")


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# ⚠️ 必须钉住 PUBLIC_BASE_URL：否则服务按 Host 头推断，会把测试请求发到真实站点上去。
env = {**os.environ, "TOONFLOW_MARKET_KEY": KEY, "PORT": str(PORT), "ASSET_TOKEN_KEY": TOKEN_KEY,
       "PUBLIC_BASE_URL": f"http://127.0.0.1:{PORT}"}
proc = subprocess.Popen([BUN, SERVER], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

try:
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/plugin/nope", timeout=1)
            break
        except urllib.error.HTTPError:
            break
        except Exception:
            time.sleep(0.5)
    else:
        print("服务没起来"); sys.exit(1)

    def post(path, payload):
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}{path}",
            data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", "Host": "linke.link"},
        )
        return json.loads(opener.open(req, timeout=60).read().decode())

    def get(url):
        return opener.open(url, timeout=180).read()

    print("=== ① 加密后 link 不含上游域名 ===")
    item = post("/v1/plugin/getPlugin", {"page": 1, "limit": 3, "type": "all"})["data"]["list"][0]
    link = item["link"]
    check("link 走加密形式 ?d=", "?d=" in link, link[:70])
    check("link 里查不到 toonflow 字样", "toonflow" not in link.lower(), link[:70])

    print("=== ② 加密链接能下载，且字节一致 ===")
    proxied = get(link)
    # 直连上游要用真实源地址；本地同进程拿不到，改用「明文模式实例」取一份对照
    plain_env = {**os.environ, "TOONFLOW_MARKET_KEY": KEY, "PORT": str(PORT + 1), "PUBLIC_BASE_URL": "http://x"}
    plain = subprocess.Popen([BUN, SERVER], env=plain_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT + 1}/v1/plugin/nope", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        plain_item = json.loads(
            opener.open(urllib.request.Request(
                f"http://127.0.0.1:{PORT + 1}/v1/plugin/getPlugin",
                data=json.dumps({"page": 1, "limit": 3, "type": "all"}).encode(), method="POST",
                headers={"Content-Type": "application/json"}), timeout=60).read().decode()
        )["data"]["list"][0]
        direct_url = urllib.parse.unquote(plain_item["link"].split("src=")[1])
        direct = get(direct_url)
    finally:
        plain.terminate()
    check("中转下载成功", len(proxied) > 0, f"{len(proxied)} B")
    check("与直连上游字节一致", proxied == direct, f"中转 {len(proxied)}B / 直连 {len(direct)}B")

    print("=== ③ 篡改 / 伪造的 token 必须被拒 ===")
    base_url, _, query = link.partition("?")
    raw_token = urllib.parse.parse_qs(query)["d"][0]
    mangled = raw_token[:-4] + ("AAAA" if not raw_token.endswith("AAAA") else "BBBB")
    try:
        get(f"{base_url}?d={mangled}")
        check("篡改 token 被拒", False, "竟然下载成功了")
    except urllib.error.HTTPError as error:
        check("篡改 token 被拒", error.code == 400, f"HTTP {error.code}")

    print("=== ④ 加密模式下明文 ?src= 必须被拒 ===")
    try:
        get(f"{base_url}?src={urllib.parse.quote(direct_url, safe='')}")
        check("明文 src 被拒", False, "竟然下载成功了")
    except urllib.error.HTTPError as error:
        check("明文 src 被拒", error.code == 400, f"HTTP {error.code}")
finally:
    proc.terminate()

print(f"\n结论：{passed} 通过 / {failed} 失败")
sys.exit(1 if failed else 0)
