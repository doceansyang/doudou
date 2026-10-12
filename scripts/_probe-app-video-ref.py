# -*- coding: utf-8 -*-
"""端到端验证：走**应用自己的 API**（不是直连 toapis），确认「带参考图的视频生成」能用。

判据 = 生成结果里参考图是否真的生效（参考图是左半洋红 / 右半青，成片必须同色）。
运行：python scripts/_probe-app-video-ref.py
"""
import json, os, shutil, subprocess, sys, time, urllib.request

FF = "C:/Users/JinYuDream/.workbuddy/tools/ffmpeg/ffmpeg.exe"
PY = "C:/Users/JinYuDream/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
API = "http://127.0.0.1:3000/api/ai/media/generate"
WORKSPACE = os.path.expandvars(r"%LOCALAPPDATA%\Programs\JinyuTV\data\workspaces\我的项目")
REF_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_out", "ref-magenta-cyan.jpg")
REF_REL = "assets/refcheck.jpg"

dst = os.path.join(WORKSPACE, REF_REL)
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.copy2(REF_SRC, dst)
print(f"[0] 参考图已放入工作区 {dst} ({os.path.getsize(dst)} bytes)")

payload = {
    "directory": WORKSPACE,
    "mediaType": "video",
    "providerId": "JinyuDream",
    "modelId": sys.argv[1] if len(sys.argv) > 1 else "wan3.0-video",
    "prompt": "参考图1：画面左半为洋红色、右半为青色，两个色块左右并排，保持颜色不变，镜头缓慢推进。",
    "duration": 2,
    "resolution": "480p",
    "ratio": "16:9",
    "generateAudio": False,
    "mode": ["imageReference:10", "videoReference:5", "audioReference:5"],
    "images": [{"path": REF_REL, "mimeType": "image/jpeg"}],
    "outputDirectory": "assets/generated",
}
print("[1] POST", API)
print(json.dumps({k: v for k, v in payload.items() if k != "directory"}, ensure_ascii=False))

req = urllib.request.Request(API, data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"}, method="POST")
# ⚠️ 本机装着系统代理：不显式绕开的话，localhost 的请求会被代理转发，
#    服务没起来时拿到的是代理的 502（"upstream connect failed"），
#    看起来像"应用报错"，其实只是服务没在跑。
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
t0 = time.time()
with NO_PROXY_OPENER.open(req, timeout=1800) as resp:
    body = json.loads(resp.read().decode())
print(f"[2] HTTP {resp.status}，耗时 {time.time() - t0:.0f}s")
print("    " + json.dumps(body, ensure_ascii=False)[:800])

if body.get("code") != 200:
    sys.exit(1)

out = (body.get("data") or [{}])[0].get("path")
out_abs = os.path.join(WORKSPACE, out) if out else ""
print(f"[3] 成片：{out_abs} ({os.path.getsize(out_abs) if out_abs and os.path.exists(out_abs) else '?'} bytes)")

frame = os.path.join(os.path.dirname(RF := os.path.abspath(__file__)), "_out", "app-ref-check.png")
subprocess.run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", out_abs,
                "-vf", "select=eq(n\\,20)", "-vframes", "1", frame], check=True)
from PIL import Image
im = Image.open(frame).convert("RGB")
w, h = im.size
L = im.crop((0, int(h * 0.35), int(w * 0.35), int(h * 0.65))).resize((1, 1)).getpixel((0, 0))
R = im.crop((int(w * 0.65), int(h * 0.35), w, int(h * 0.65))).resize((1, 1)).getpixel((0, 0))
ok = L[0] > 150 and L[2] > 120 and R[1] > 150 and R[2] > 150
print(f"[4] 成片 {w}x{h} 左={L} 右={R}  →  参考图{'已生效 ✓' if ok else '未生效 ✗'}")
