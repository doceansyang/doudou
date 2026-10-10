# -*- coding: utf-8 -*-
"""「外部网页返回条」端到端验证。

流程：
  ① 编译一份带 NAVTEST 的测试启动器（_navtest.exe，正式包不含该分支）；
  ② 编译驱动 BackBarProbe.exe（它会模拟点击与按键，并用日志判定状态）；
  ③ 停掉旧窗口 → 确认服务在跑 → 跑探针。

用法：python scripts/_probe-backbar.py
"""
import os
import subprocess
import sys
import time

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
SCRIPTS = os.path.join(PROJECT, "scripts")
PORTABLE = os.path.join(BASE, "JinyuTV-portable")
OUT = os.path.join(SCRIPTS, "_out")
WV2 = os.path.join(PROJECT, "tools", "webview2")

CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")

REFS = ["System.dll", "System.Core.dll", "System.Drawing.dll",
        "System.Windows.Forms.dll", "System.Management.dll"]
REFS = ["/r:" + r for r in REFS] + [
    "/r:" + os.path.join(WV2, "Microsoft.Web.WebView2.Core.dll"),
    "/r:" + os.path.join(WV2, "Microsoft.Web.WebView2.WinForms.dll"),
]


def build(out_path, source, extra_defines=None):
    cmd = [CSC, "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
           "/out:" + out_path, source] + REFS
    if extra_defines:
        cmd.insert(1, "/define:" + extra_defines)
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not os.path.exists(out_path):
        print("  !! 编译失败 %s：%s" % (source, (proc.stdout or proc.stderr)[:600]))
        return False
    print("  ✓ %s（%.1f KB）" % (os.path.basename(out_path), os.path.getsize(out_path) / 1024))
    return True


def kill(name):
    subprocess.run(["taskkill", "/IM", name, "/F"], capture_output=True)


def port_alive(port=3000):
    import socket
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    print("=== 1) 编译测试版启动器（NAVTEST）===")
    navtest = os.path.join(PORTABLE, "_navtest.exe")
    if not build(navtest, os.path.join(SCRIPTS, "launcher.cs"), "NAVTEST"):
        return 1

    print("=== 2) 编译验证驱动 ===")
    driver = os.path.join(SCRIPTS, "_probe-backbar.exe")
    if not build(driver, os.path.join(SCRIPTS, "_probe-backbar.cs")):
        return 1

    print("=== 3) 停旧窗口 + 确保服务在跑 ===")
    kill("JinyuTV.exe")
    kill("_navtest.exe")
    time.sleep(1.5)
    if not port_alive():
        print("  服务未在跑，拉起 start-server.bat …")
        subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=PORTABLE,
                         creationflags=0x08000000)
        for _ in range(60):
            time.sleep(1)
            if port_alive():
                break
    print("  3000 端口：%s" % ("在监听" if port_alive() else "!! 未监听"))
    time.sleep(2)

    print("=== 4) 运行验证 ===")
    proc = subprocess.run([driver, OUT, navtest], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=420)
    print(proc.stdout)
    if proc.stderr.strip():
        print("[stderr]", proc.stderr.strip()[:500])

    print("=== 5) 启动器日志（返回条相关）===")
    log = os.path.join(PORTABLE, "logs", "launcher.log")
    if os.path.isfile(log):
        with open(log, encoding="utf-8", errors="replace") as f:
            for line in f.readlines()[-25:]:
                print("  " + line.rstrip())

    print("=== 产物 ===")
    for name in ("backbar-1.png", "backbar-2.png", "backbar-3.png", "backbar-probe.log"):
        p = os.path.join(OUT, name)
        print("  %-22s %s" % (name, "%.1f KB" % (os.path.getsize(p) / 1024) if os.path.isfile(p) else "(无)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
