# -*- coding: utf-8 -*-
"""在「临时关闭 Windows 系统代理」的状态下跑 electrobun 打包，结束后自动恢复。

为什么需要这样：
  hutch 是原生程序，它读 **Windows 系统代理**（注册表 ProxyEnable/ProxyServer），
  而不是 http_proxy 环境变量。本机系统代理指向 127.0.0.1:7897（代理软件没在跑），
  于是 hutch 下载 bun 工具链时直接 ECONNREFUSED；
  而 curl 不走代理时访问 GitHub 是通的（206 / 1 秒）。
  所以：打包期间临时把 ProxyEnable 置 0，跑完无论成败都恢复原值。

用法：python scripts/pack-without-proxy.py
"""
import os
import subprocess
import sys
import winreg

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
ELECTROBUN = os.path.join(PROJECT, "apps", "desktop", "node_modules", "electrobun", "bin", "electrobun.cjs")

REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
PROXY_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]


def build_env():
    env = dict(os.environ)
    for key in PROXY_KEYS:
        env.pop(key, None)
    env["PATH"] = os.pathsep.join([
        os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"),
        os.environ.get("SystemRoot", r"C:\Windows"),
        os.path.dirname(BUN),
        env.get("PATH", ""),
    ])
    return env


def main():
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_READ | winreg.KEY_WRITE)
    old_enable, _ = winreg.QueryValueEx(key, "ProxyEnable")
    try:
        old_server, _ = winreg.QueryValueEx(key, "ProxyServer")
    except FileNotFoundError:
        old_server = None
    print("原系统代理: ProxyEnable=%s ProxyServer=%s" % (old_enable, old_server))

    try:
        winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, 0)
        print("→ 已临时关闭系统代理，开始打包…\n")
        proc = subprocess.run(
            [BUN, ELECTROBUN, "build", "--env=stable"],
            cwd=PROJECT, env=build_env(), capture_output=True,
            text=True, encoding="utf-8", errors="replace",
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        print(out[-4000:] if out else "(无 stdout)")
        if err:
            print("[stderr] " + err[-2000:])
        print("\n退出码: %d" % proc.returncode)
        return proc.returncode
    finally:
        winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, old_enable)
        if old_server is not None:
            winreg.SetValueEx(key, "ProxyServer", 0, winreg.REG_SZ, old_server)
        print("→ 已恢复系统代理: ProxyEnable=%s" % old_enable)


if __name__ == "__main__":
    sys.exit(main())
