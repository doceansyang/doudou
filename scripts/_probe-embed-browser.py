# -*- coding: utf-8 -*-
"""驱动「浏览器窗口能否嵌进我们窗口」的探针：编译 -> 运行 -> 报告。

用法：
  python scripts/_probe-embed-browser.py [chrome|edge]
产物：
  scripts/_out/embed-probe.png   宿主窗口截图（看浏览器有没有渲染出来）
  scripts/_out/embed-probe.log   探针轨迹
"""
import os
import subprocess
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
SCRIPTS = os.path.join(BASE, "toonflow", "scripts")
SRC = os.path.join(SCRIPTS, "_probe-embed-browser.cs")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
OUT_DIR = os.path.join(SCRIPTS, "_out")
EXE = os.path.join(OUT_DIR, "ProbeEmbed.exe")

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
         "/r:System.Windows.Forms.dll", "/out:" + EXE, SRC],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SystemExit("编译失败：%s" % (proc.stdout or proc.stderr))
    print("  ok -> %s" % EXE)

    png = os.path.join(OUT_DIR, "embed-probe.png")
    for p in (png, os.path.join(OUT_DIR, "embed-probe.log")):
        try:
            os.remove(p)
        except OSError:
            pass

    print("--- 运行探针（浏览器=%s）" % which)
    run = subprocess.run([EXE, png, browser], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=180)
    if run.stdout:
        print(run.stdout.strip()[:800])

    log = os.path.join(OUT_DIR, "embed-probe.log")
    if os.path.exists(log):
        print("--- 探针轨迹")
        with open(log, encoding="utf-8", errors="replace") as fh:
            print(fh.read().strip())
    print("--- 截图：%s（%s）" % (png, "已生成" if os.path.exists(png) else "未生成"))


if __name__ == "__main__":
    sys.exit(main())
