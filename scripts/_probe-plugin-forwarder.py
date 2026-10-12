# -*- coding: utf-8 -*-
"""自检：插件中转服务（tools/plugin-forwarder）能不能用、去品牌是否彻底。

会自己拉起服务（用 settings.json 里那把市场 key），跑完一定把它们杀掉。

判据：
  ① 经中转发回的列表 —— 条数 / 标识顺序 / 字段集合与直查上游完全一致；
  ② 去品牌：条目里的 `link` 已改写成本服务地址（`/v1/plugin/asset/…?src=` 指向 TOS），
     客户端侧**看不到 toonflow 域名**；
  ③ 下载代理真能取到文件，且**字节数与直连上游完全一致**；
  ④ 白名单之外一律 403（非 TOS 主机、非 `/plugins/` 路径）—— 它不是开放代理；
  ⑤ 上游拒绝（坏 key）时回的是**人话**（502 + 中文提示），不把上游原文/HTML 甩出去；
  ⑥ 没放行的路径一律 404；
  ⑦ 缓存里存的是**改写前**的原始体：换 Host 请求，各自拿到**自己**域名下的下载地址（不串）；
  ⑧ `PROXY_DOWNLOAD=0` 时 link 保持原样（留一条退路：中转带宽不够时直连上游）。
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
SETTINGS = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV\data\settings.json"
NODE = r"C:\Users\JinYuDream\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
PORT = 8787
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(url, body=None, headers=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with OPENER.open(req, timeout=60) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode())
            except Exception:
                return r.status, {"_bytes": len(raw)}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:200]}
    except Exception as e:
        return 0, {"_error": f"{type(e).__name__}: {e}"}


settings = json.load(open(SETTINGS, encoding="utf-8"))["settings"]
KEY = (settings.get("pluginMarketApiKey") or "").strip()
if not KEY:
    sys.exit("settings.json 里没有 pluginMarketApiKey —— 先在「设置 → 插件市场」里填一把")

failures = 0


def check(label, ok, detail=""):
    global failures
    print(f"  {'✓' if ok else '✗'} {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures += 1


def start(port, key, extra_env=None):
    env = dict(os.environ, TOONFLOW_MARKET_KEY=key, PORT=str(port), **(extra_env or {}))
    env.pop("http_proxy", None)
    env.pop("https_proxy", None)
    proc = subprocess.Popen([NODE, os.path.join(PROJECT, "tools", "plugin-forwarder", "server.mjs")],
                            cwd=PROJECT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    for _ in range(30):
        time.sleep(0.4)
        status, _ = request(f"http://127.0.0.1:{port}/v1/plugin/getPlugin", {})
        if status:
            return proc
    return proc


print("=== ① 经中转 vs 直查上游 ===")
local = f"http://127.0.0.1:{PORT}"
good = start(PORT, KEY)
try:
    body = {"page": 1, "limit": 50, "type": "all"}
    ds, direct = request("https://api.toonflow.net/v1/plugin/getPlugin", body, {"Authorization": "Bearer " + KEY})
    vs, via = request(f"{local}/v1/plugin/getPlugin", body, {"Origin": "http://127.0.0.1:3000"})
    dlist = (direct.get("data") or {}).get("list") or []
    vlist = (via.get("data") or {}).get("list") or []
    check("两者都返回 200", ds == 200 and vs == 200, f"direct={ds} via={vs}")
    check("条数一致", len(dlist) == len(vlist), f"{len(dlist)} vs {len(vlist)}")
    check("插件标识顺序完全一致",
          [x.get("identifier") for x in dlist] == [x.get("identifier") for x in vlist])
    check("除 link 外字段值一致",
          bool(dlist) and all(
              {k: v for k, v in a.items() if k != "link"} == {k: v for k, v in b.items() if k != "link"}
              for a, b in zip(dlist, vlist)))

    print("\n=== ② 去品牌：link 改写成走本服务 ===")
    vlink = str(vlist[0].get("link", "")) if vlist else ""
    dlink = str(dlist[0].get("link", "")) if dlist else ""
    parts = urllib.parse.urlparse(vlink)
    qs = urllib.parse.parse_qs(parts.query)
    check("link 指向本服务的下载代理", vlink.startswith(f"{local}/v1/plugin/asset/"), vlink[:110])
    check("原地址作为 src 参数带上了（且仍是 TOS 签名链）",
          "tos-cn-beijing.volces.com" in qs.get("src", [""])[0] and "X-Tos-Signature" in qs.get("src", [""])[0])
    check("link 里不再直接出现 toonflow 域名",
          "toonflow.tos-" not in parts.netloc and "toonflow" not in parts.netloc, parts.netloc)
    check("path 末段保留了文件名（服务端缺 fileName 时会从这里取）",
          urllib.parse.unquote(parts.path.rsplit("/", 1)[-1]) == str(vlist[0].get("fileName", "")),
          urllib.parse.unquote(parts.path.rsplit("/", 1)[-1]))

    print("\n=== ③ 下载代理真的能取到文件 ===")
    ds2, dfile = request(dlink)
    vs2, vfile = request(vlink)
    dbytes, vbytes = dfile.get("_bytes"), vfile.get("_bytes")
    check("两侧都能下到字节", ds2 == 200 and vs2 == 200, f"直连={ds2}/{dbytes}B　经中转={vs2}/{vbytes}B")
    check("字节数完全一致", dbytes is not None and dbytes == vbytes, f"{dbytes} vs {vbytes}")

    print("\n=== ④ 白名单之外一律 403 ===")
    bad_targets = {
        "非 TOS 主机": "https://example.com/plugins/x.zip",
        "TOS 但不是 /plugins/ 路径": "https://toonflow.tos-cn-beijing.volces.com/other/x.zip",
        "内网地址": "http://127.0.0.1:3000/api/settings/get",
    }
    for label, target in bad_targets.items():
        s, _ = request(f"{local}/v1/plugin/asset/x.zip?src={urllib.parse.quote(target, safe='')}")
        check(f"拒绝{label}", s == 403, f"HTTP {s}")

    print("\n=== ⑦ 缓存按请求 Host 改写（不串域名）===")
    s1, r1 = request(f"{local}/v1/plugin/getPlugin", body, {"Host": "a.example.com"})
    s2, r2 = request(f"{local}/v1/plugin/getPlugin", body, {"Host": "b.example.com"})
    l1 = str(((r1.get("data") or {}).get("list") or [{}])[0].get("link", ""))
    l2 = str(((r2.get("data") or {}).get("list") or [{}])[0].get("link", ""))
    check("两次各拿到自己 Host 下的下载地址",
          l1.startswith("http://a.example.com/") and l2.startswith("http://b.example.com/"),
          f"{l1[:42]}… / {l2[:42]}…")

    print("\n=== ⑤ 未放行的路径 ===")
    s, _ = request(f"{local}/v1/chat/completions", {})
    check("不是一个通用代理（404）", s == 404, f"HTTP {s}")

    print("\n=== ⑧ PROXY_DOWNLOAD=0 的退路 ===")
    plain = start(8789, KEY, {"PROXY_DOWNLOAD": "0"})
    try:
        ps, pres = request("http://127.0.0.1:8789/v1/plugin/getPlugin", body)
        plink = str(((pres.get("data") or {}).get("list") or [{}])[0].get("link", ""))
        check("link 保持上游原样（不经过中转）",
              ps == 200 and plink.startswith("https://") and "/v1/plugin/asset/" not in plink,
              plink[:80])
    finally:
        plain.terminate()

    print("\n=== ⑥ 坏 key 时的表现 ===")
    bad = start(8788, "sk-definitely-not-a-real-key")
    try:
        bs, bbody = request("http://127.0.0.1:8788/v1/plugin/getPlugin", {"page": 1, "limit": 1, "type": "all"})
        msg = str(bbody.get("message", ""))
        check("不回 5xx 原文，而是 502 + 人话", bs == 502 and "插件服务暂时不可用" in msg, f"HTTP {bs} {msg[:40]}")
        check("响应里没有泄漏 key", KEY not in json.dumps(bbody))
    finally:
        bad.terminate()
finally:
    good.terminate()

print("\n结论：" + ("全部通过" if not failures else f"{failures} 项未通过"))
sys.exit(1 if failures else 0)
