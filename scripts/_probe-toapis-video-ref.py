# -*- coding: utf-8 -*-
"""诊断：toapis 视频生成「带参考图」到底行不行。

流程 = 上传本地图 → 换公网 URL → POST /v1/videos/generations（带参考图）→ 打印**完整**响应体
（含嵌套 message，这是判定的关键：`fail_to_fetch_task` 的真正原因藏在里面）→ 若 200 则轮询下载。

用最便宜的档位（wan3.0-video / 2s / 480p），一次跑完拿结论。

运行:
  TOAPIS_KEY=sk-... python scripts/_probe-toapis-video-ref.py [模型] [时长] [分辨率]
"""
import json, os, sys, time, urllib.error, urllib.request
from PIL import Image

BASE = "https://toapis.cn"
KEY = os.environ.get("TOAPIS_KEY", "")
if not KEY:
    sys.exit("错误：未设置 TOAPIS_KEY")

MODEL = sys.argv[1] if len(sys.argv) > 1 else "wan3.0-video"
DUR = int(sys.argv[2]) if len(sys.argv) > 2 else 2
RES = sys.argv[3] if len(sys.argv) > 3 else "480p"

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_out")
os.makedirs(OUT, exist_ok=True)


def make_ref():
    """左半洋红 / 右半青 —— 模型若真收到这张图，成片必然是这两个色块。"""
    p = os.path.join(OUT, "ref-magenta-cyan.jpg")
    im = Image.new("RGB", (512, 512))
    px = im.load()
    for y in range(512):
        for x in range(512):
            px[x, y] = (255, 0, 255) if x < 256 else (0, 255, 255)
    im.save(p, quality=92)
    return p


def req(path, payload=None, method="POST", timeout=90, raw=False):
    hdr = {"Authorization": "Bearer " + KEY}
    body = None
    if payload is not None:
        hdr["Content-Type"] = "application/json"
        body = json.dumps(payload, ensure_ascii=False).encode()
    r = urllib.request.Request(BASE + path, data=body, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"_raw": txt[:2000]}


def upload(path, kind="images"):
    fn = os.path.basename(path)
    ctype = "image/jpeg" if fn.endswith((".jpg", ".jpeg")) else "image/png"
    boundary = "----probe" + os.urandom(8).hex()
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{fn}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n").encode()
    body = head + open(path, "rb").read() + b"\r\n" + f"--{boundary}--\r\n".encode()
    r = urllib.request.Request(BASE + f"/v1/uploads/{kind}", data=body, method="POST",
                               headers={"Authorization": "Bearer " + KEY,
                                        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=120) as resp:
        d = json.loads(resp.read().decode())
    if not d.get("success"):
        sys.exit(f"上传失败: {d}")
    return d["data"]["url"]


ref = make_ref()
print(f"[1] 本机参考图 {ref}  ({os.path.getsize(ref)} bytes)")
url = upload(ref)
print(f"[2] 上传成功 → {url}")

payload = {
    "model": MODEL,
    "prompt": "参考图1：画面左半为洋红色、右半为青色，两个色块左右并排，保持颜色不变。",
    "duration": DUR,
    "resolution": RES,
}
if MODEL.lower().startswith("wan"):
    payload.update({"ratio": "16:9", "reference_images": [url]})
else:
    payload.update({"aspect_ratio": "16:9",
                    "image_with_roles": [{"url": url, "role": "reference_image"}]})

print("[3] 提交请求体：")
print(json.dumps(payload, ensure_ascii=False, indent=2))
status, body = req("/v1/videos/generations", payload)
print(f"[4] HTTP {status}")
print(json.dumps(body, ensure_ascii=False, indent=2)[:2000])

if status != 200:
    sys.exit(0)

tid = body.get("id") or body.get("task_id")
print(f"[5] task={tid} 轮询中（最长 10 分钟）…")
t0 = time.time()
while time.time() - t0 < 600:
    time.sleep(8)
    st, d = req(f"/v1/videos/generations/{tid}", method="GET")
    s = str(d.get("status") or (d.get("data") or {}).get("status") or "")
    print(f"    {int(time.time()-t0):>4}s  {s}  {json.dumps(d, ensure_ascii=False)[:300]}")
    if s == "completed":
        items = (d.get("result") or {}).get("data") or []
        vu = (items[0].get("url") if items else None) or d.get("url")
        print(f"[6] 完成 → {vu}")
        if vu:
            dst = os.path.join(OUT, "ref-check.mp4")
            urllib.request.urlretrieve(vu, dst)
            print(f"[7] 已下载 {dst} ({os.path.getsize(dst)} bytes)")
        break
    if s in ("failed", "error"):
        print("[6] 失败，完整响应：")
        print(json.dumps(d, ensure_ascii=False, indent=2))
        break
