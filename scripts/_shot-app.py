# -*- coding: utf-8 -*-
"""启动 JinyuTV 并截图，用于客观检查渲染与布局。

用法：
  python scripts/_shot-app.py [green|installed] [等待毫秒] [--attach]
  --attach：不新起进程，直接抓当前已打开的那个窗口
            （窗口在第二块显示器/被最小化时，必须走这条路才有内容）
产物：
  scripts/_out/app-shot.png   窗口截图
  scripts/_out/app-shot.info  窗口矩形等硬数据
"""
import os
import subprocess
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
SCRIPTS = os.path.join(BASE, "toonflow", "scripts")
SRC = os.path.join(SCRIPTS, "_shot-app.cs")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
OUT_DIR = os.path.join(SCRIPTS, "_out")
EXE = os.path.join(OUT_DIR, "ShotApp.exe")

TARGETS = {
    "green": os.path.join(BASE, "JinyuTV-portable", "JinyuTV.exe"),
    "installed": os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV", "JinyuTV.exe"),
}


def main():
    args = sys.argv[1:]
    attach = "--attach" in args
    args = [a for a in args if a != "--attach"]
    which = (args[0] if args else "green").lower()
    wait = args[1] if len(args) > 1 else "18000"
    target = TARGETS.get(which, TARGETS["green"])
    if not os.path.isfile(target):
        raise SystemExit("找不到目标：%s" % target)

    os.makedirs(OUT_DIR, exist_ok=True)

    print("--- 编译截图工具")
    proc = subprocess.run(
        [CSC, "/nologo", "/target:exe", "/platform:x64",
         "/r:System.dll", "/r:System.Core.dll", "/r:System.Drawing.dll",
         "/r:System.Windows.Forms.dll", "/out:" + EXE, SRC],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SystemExit("编译失败：%s" % (proc.stdout or proc.stderr))
    print("  ok")

    png = os.path.join(OUT_DIR, "app-shot.png")
    info = png + ".info"
    for p in (png, info, png + ".err"):
        try:
            os.remove(p)
        except OSError:
            pass

    print("--- %s并截图：%s%s" % ("抓当前窗口" if attach else "启动", target,
                                  "" if attach else "（等 %s ms）" % wait))
    cmd = [EXE, png, target, wait] + (["--attach"] if attach else [])
    try:
        run = subprocess.run(cmd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=150)
        if run.stdout.strip():
            print("  " + run.stdout.strip())
        if run.stderr.strip():
            print("  [stderr] " + run.stderr.strip()[:400])
    except subprocess.TimeoutExpired:
        # 截图本身通常已经写盘；超时多半是子进程句柄没释放，不影响产物
        print("  ! 截图进程未按时退出（若无产物再排查）")

    for p, label in ((png, "截图"), (info, "窗口数据"), (png + ".err", "错误")):
        if os.path.exists(p):
            print("--- %s：%s" % (label, p))
            if p != png:
                print(open(p, encoding="utf-8", errors="replace").read().strip())


if __name__ == "__main__":
    sys.exit(main())
