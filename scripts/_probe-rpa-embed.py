# -*- coding: utf-8 -*-
"""驱动「豆包浏览器窗口自动收编进侧栏」的探针：编译 -> 运行 -> 报告。

用法：
  python scripts/_probe-rpa-embed.py [chrome|edge]
产物：
  scripts/_out/rpa-embed-probe.png   宿主窗口截图（左=工作台，右=收编进来的豆包窗口）
  scripts/_out/rpa-embed-probe.log   探针轨迹（含 WMI 命中情况）
"""
import os
import subprocess
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
SCRIPTS = os.path.join(BASE, "toonflow", "scripts")
SRC = os.path.join(SCRIPTS, "_probe-rpa-embed.cs")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
OUT_DIR = os.path.join(SCRIPTS, "_out")
EXE = os.path.join(OUT_DIR, "ProbeRpaEmbed.exe")

BROWSERS = {
    "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "edge": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
}


def main():
    which = (sys.argv[1] if len(sys.argv) > 1 else "chrome").lower()
    browser = BROWSERS.get(which, BROWSERS["chrome"])
    if not os.path.isfile(browser):
        raise SystemExit("找不到浏览器：%s" % browser)

    os.makedirs(OUT_DIR, exist_ok=True)
    if not os.path.exists(CSC):
        raise SystemExit("找不到 C# 编译器：%s" % CSC)

    print("--- 编译探针")
    proc = subprocess.run(
        [CSC, "/nologo", "/target:winexe", "/platform:x64",
         "/r:System.dll", "/r:System.Core.dll", "/r:System.Drawing.dll",
         "/r:System.Windows.Forms.dll", "/r:System.Management.dll",
         "/out:" + EXE, SRC],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SystemExit("编译失败：%s" % (proc.stdout or proc.stderr))
    print("  ok -> %s" % EXE)

    png = os.path.join(OUT_DIR, "rpa-embed-probe.png")
    log = os.path.join(OUT_DIR, "rpa-embed-probe.log")
    for p in (png, log):
        try:
            os.remove(p)
        except OSError:
            pass

    print("--- 运行探针（浏览器=%s）" % which)
    try:
        run = subprocess.run([EXE, png, browser], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=240)
        if run.stdout:
            print(run.stdout.strip()[:800])
    except subprocess.TimeoutExpired:
        print("  ! 探针超时（GUI 进程被宿主回收时属正常）")

    if os.path.exists(log):
        print("--- 探针轨迹")
        with open(log, encoding="utf-8", errors="replace") as fh:
            print(fh.read().strip())
    print("--- 截图：%s（%s）" % (png, "已生成" if os.path.exists(png) else "未生成"))


if __name__ == "__main__":
    sys.exit(main())
