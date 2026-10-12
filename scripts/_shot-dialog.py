# -*- coding: utf-8 -*-
"""抓取 JinyuTV 的**授权弹窗**（无边框无标题，按尺寸特征定位）。

和 _shot-app.py 同构，但目标窗口不同：_shot-app.py 抓标题为 "JinyuTV" 的主窗口，
本脚本抓 620x540 的无边框弹窗。

用法：
  python scripts/_shot-dialog.py [--attach]
产物：
  scripts/_out/dialog-shot.png         + .screen.png（屏幕对照）
  scripts/_out/dialog-shot.png.info    窗口矩形等硬数据
"""
import os
import subprocess
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
SCRIPTS = os.path.join(BASE, "toonflow", "scripts")
SRC = os.path.join(SCRIPTS, "_shot-dialog.cs")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
OUT_DIR = os.path.join(SCRIPTS, "_out")
EXE = os.path.join(OUT_DIR, "ShotDialog.exe")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print("--- 编译弹窗抓图工具")
    proc = subprocess.run(
        [CSC, "/nologo", "/target:exe", "/platform:x64",
         "/r:System.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
         "/out:" + EXE, SRC],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SystemExit("编译失败：%s" % (proc.stdout or proc.stderr))
    print("  ok")

    png = os.path.join(OUT_DIR, "dialog-shot.png")
    for p in (png, png + ".info", png + ".err",
              os.path.join(OUT_DIR, "dialog-shot-screen.png")):
        try:
            os.remove(p)
        except OSError:
            pass

    print("--- 抓取授权弹窗")
    try:
        run = subprocess.run([EXE, png], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=120)
        if run.stdout.strip():
            print("  " + run.stdout.strip())
        if run.stderr.strip():
            print("  [stderr] " + run.stderr.strip()[:400])
    except subprocess.TimeoutExpired:
        print("  ! 抓图进程未按时退出（若无产物再排查）")

    for p, label in ((png, "弹窗截图"), (png + ".info", "窗口数据"),
                     (png + ".err", "错误")):
        if os.path.exists(p):
            print("--- %s：%s" % (label, p))
            if p != png:
                print(open(p, encoding="utf-8", errors="replace").read().strip())


if __name__ == "__main__":
    sys.exit(main())
