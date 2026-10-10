# -*- coding: utf-8 -*-
"""验证「返回条 / 侧栏标题条」不再遮挡网页内容。

判据不是肉眼看截图 —— 而是**量出真实子窗口矩形**：
  · 返回条可见时，WebView2 的子窗口 top 应当 == 38（返回条高度），而不是 0。
  · top == 0 就说明网页铺满了整个客户区、被返回条盖住了上面 38px（用户报的「遮挡」）。

做法：编译带 NAVTEST 的测试启动器（会自动跳到外部网页）→ 等日志出现「已离开软件」
→ EnumChildWindows 打印所有子窗口的类名与矩形。

用法：python toonflow/scripts/_probe-navbar-cover.py
"""
import ctypes
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
SCRIPTS = os.path.join(PROJECT, "scripts")
PORTABLE = os.path.join(BASE, "JinyuTV-portable")
WV2 = os.path.join(PROJECT, "tools", "webview2")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
REFS = ["/r:" + r for r in ["System.dll", "System.Core.dll", "System.Drawing.dll",
                            "System.Windows.Forms.dll", "System.Management.dll"]] + [
    "/r:" + os.path.join(WV2, "Microsoft.Web.WebView2.Core.dll"),
    "/r:" + os.path.join(WV2, "Microsoft.Web.WebView2.WinForms.dll"),
]
NAV_H = 38
LOG = os.path.join(PORTABLE, "logs", "launcher.log")

u = ctypes.windll.user32
u.SetProcessDPIAware()


class RECT(ctypes.Structure):
    _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]


def build(out_path, define=None):
    cmd = [CSC, "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
           "/out:" + out_path, os.path.join(SCRIPTS, "launcher.cs")] + REFS
    if define:
        cmd.insert(1, "/define:" + define)
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0 or not os.path.exists(out_path):
        print("  !! 编译失败：" + (p.stdout or p.stderr)[:600])
        return False
    print("  ✓ %s（%.1f KB）" % (os.path.basename(out_path), os.path.getsize(out_path) / 1024))
    return True


def kill(name):
    subprocess.run(["taskkill", "/IM", name, "/F"], capture_output=True)


def port_alive(port=3000):
    import socket
    s = socket.socket(); s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", port)); return True
    except Exception:
        return False
    finally:
        s.close()


def find_main():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        n = u.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        if buf.value != "JinyuTV" or not u.IsWindowVisible(hwnd):
            return True
        r = RECT(); u.GetWindowRect(hwnd, ctypes.byref(r))
        found.append((hwnd, r.l, r.t, r.r - r.l, r.b - r.t))
        return True

    u.EnumWindows(cb, 0)
    return max(found, key=lambda x: x[3] * x[4]) if found else None


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def children(hwnd):
    """一次性枚举全部后代（EnumChildWindows 本身就是递归的），
    位置统一换算成「相对主窗口客户区原点」——这才是判断遮挡的正确坐标系。"""
    origin = POINT(0, 0)
    u.ClientToScreen(hwnd, ctypes.byref(origin))
    out = []
    rows = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        r = RECT()
        if not u.GetWindowRect(h, ctypes.byref(r)):
            return True
        rows.append((cls.value, r.l - origin.x, r.t - origin.y, r.r - r.l, r.b - r.t,
                     bool(u.IsWindowVisible(h))))
        return True

    u.EnumChildWindows(hwnd, cb, 0)
    return rows


def main():
    print("=== 1) 编译 NAVTEST 测试启动器 ===")
    navtest = os.path.join(PORTABLE, "_navtest.exe")
    if not build(navtest, "NAVTEST"):
        return 1

    print("=== 2) 停旧窗口 + 确认服务 ===")
    kill("JinyuTV.exe"); kill("_navtest.exe")
    time.sleep(1.5)
    if not port_alive():
        subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=PORTABLE, creationflags=0x08000000)
        for _ in range(60):
            time.sleep(1)
            if port_alive():
                break
    print("  3000 端口：%s" % ("在监听" if port_alive() else "!! 未监听"))

    print("=== 3) 启动测试启动器，等它跳到外部网页 ===")
    if os.path.isfile(LOG):
        os.remove(LOG)
    subprocess.Popen([navtest], cwd=PORTABLE, close_fds=True)
    left = False
    for _ in range(60):
        time.sleep(1)
        if os.path.isfile(LOG):
            try:
                text = open(LOG, encoding="utf-8", errors="replace").read()
            except Exception:
                text = ""
            if "已离开软件" in text:
                left = True
                break
    print("  是否已跳到外部网页：%s" % ("是" if left else "否（超时）"))
    time.sleep(2)

    print("=== 4) 量真实子窗口矩形 ===")
    m = find_main()
    if not m:
        print("  !! 没找到 JinyuTV 主窗口"); return 1
    hwnd, x, y, w, h = m
    print("  主窗口 hwnd=%d  位置(%d,%d) 尺寸 %dx%d" % (hwnd, x, y, w, h))
    kids = children(hwnd)
    # 只看「够大、且可见」的窗口，并按面积从大到小 —— 网页窗口一定是最大的那个
    big = [k for k in kids if k[3] > 100 and k[4] > 100 and k[5]]
    big.sort(key=lambda k: -(k[3] * k[4]))
    print("  %-34s %-14s %-12s" % ("类名", "相对客户区", "尺寸"))
    for cls, cx, cy, cw, ch, _vis in big[:8]:
        print("  %-34s (%5d,%4d)  %4dx%-4d" % (cls[:34], cx, cy, cw, ch))

    # 网页窗口 = 最大的那个可见后代（Chrome_WidgetWin / 其宿主）
    web = big[0] if big else None
    print()
    if web is None:
        print("  结论：没识别到网页窗口")
        return 1
    cls, cx, cy, cw, ch, _ = web
    print("  最大子窗口：%s  top=%d 高=%d" % (cls[:34], cy, ch))
    if left and cy >= NAV_H - 2:
        print("  ✅ 通过：网页从返回条下方（y=%d）开始，返回条没有盖住网页" % cy)
        return 0
    print("  ❌ 不通过：网页 top=%d（应 ≥ %d）—— 上半部分被返回条盖住了" % (cy, NAV_H))
    return 1


if __name__ == "__main__":
    sys.exit(main())
