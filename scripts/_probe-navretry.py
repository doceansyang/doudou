# -*- coding: utf-8 -*-
"""验证启动器的「界面载入失败自动重试」（回归用）。

场景还原：服务被外部重启/停掉时，窗口原来会停在 WebView2 的错误页（整片白），
只能手动关掉重开。现在 launcher 会在失败后每 1.5 秒重试，服务一回来界面自己恢复。

步骤（全部在同一条命令里完成，否则会被工具宿主回收进程）：
  ① 清掉所有 JinyuTV 窗口 → 起服务 → 启动绿色版窗口（此时页面正常）
  ② 杀掉服务 → 给窗口发 F5 → 页面必然载入失败 → 应触发重试
  ③ 重新起服务 → 等重试成功 → 截图取证

用法：python scripts/_probe-navretry.py
"""
import ctypes
import os
import socket
import subprocess
import sys
import time
from ctypes import wintypes

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PORTABLE = os.path.join(BASE, "JinyuTV-portable")
SCRIPTS = os.path.join(BASE, "toonflow", "scripts")
OUT = os.path.join(SCRIPTS, "_out")
LOG = os.path.join(PORTABLE, "logs", "launcher.log")
EXE = os.path.join(PORTABLE, "JinyuTV.exe")

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def alive(port=3000):
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def kill(image):
    subprocess.run(["taskkill", "/IM", image, "/F"], capture_output=True)


def find_window():
    """找可见的 JinyuTV 主窗口（取面积最大的）。"""
    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]

    best = []
    proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if buf.value != "JinyuTV":
            return True
        r = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        area = (r.r - r.l) * (r.b - r.t)
        if not best or area > best[0][0]:
            best.append((area, hwnd, r.l, r.t, r.r - r.l, r.b - r.t))
        return True

    user32.EnumWindows(proc(cb), 0)
    return best[-1] if best else None


def foreground(hwnd):
    fg = user32.GetForegroundWindow()
    tid_fg = user32.GetWindowThreadProcessId(fg, None)
    tid_me = ctypes.windll.kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(tid_me, tid_fg, True)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.AttachThreadInput(tid_me, tid_fg, False)


def click_center(x, y, w, h):
    user32.SetCursorPos(x + w // 2, y + h // 2)
    time.sleep(0.3)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def press(key):
    user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.08)
    user32.keybd_event(key, 0, 2, 0)


def read_log():
    try:
        with open(LOG, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def start_server_and_wait(seconds=45):
    subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=PORTABLE,
                     creationflags=0x08000000)
    for _ in range(seconds):
        time.sleep(1)
        if alive():
            return True
    return False


def main():
    os.makedirs(OUT, exist_ok=True)
    print("=== ① 清场并启动窗口 ===")
    kill("JinyuTV.exe")
    kill("bun.exe")
    time.sleep(1.5)
    print("  服务：", "起服务" if start_server_and_wait() else "!! 起不来")
    subprocess.Popen(["cmd", "/c", "start", "", EXE], cwd=PORTABLE,
                     creationflags=0x08000000)
    window = None
    for _ in range(40):
        time.sleep(1)
        window = find_window()
        if window:
            break
    if not window:
        print("!! 没等到窗口")
        return 1
    _, hwnd, x, y, w, h = window
    print("  窗口 hwnd=%d 位置(%d,%d) %dx%d" % (hwnd, x, y, w, h))
    time.sleep(6)

    print("=== ② 停掉服务 → 刷新页面（制造载入失败）===")
    kill("bun.exe")
    time.sleep(2)
    print("  3000 是否在监听：", alive())
    before = read_log().count("第 1 次重试")
    foreground(hwnd)
    time.sleep(0.8)
    click_center(x, y, w, h)
    time.sleep(0.5)
    press(0x74)  # F5
    print("  已发 F5，等 5 秒看是否触发重试…")
    time.sleep(5)
    retried = read_log().count("第 1 次重试") > before
    print("  日志出现「界面载入失败，第 1 次重试」：", retried)

    print("=== ③ 恢复服务 → 等界面自愈 ===")
    ok = start_server_and_wait()
    print("  服务已恢复：", ok)
    time.sleep(12)

    print("=== ④ 截图取证 + 校验是否真的恢复 ===")
    subprocess.run(["C:/Users/JinYuDream/.workbuddy/binaries/python/versions/3.13.12/python.exe",
                    os.path.join(SCRIPTS, "_shot-app.py"), "green", "0", "--attach"],
                   cwd=BASE, capture_output=True, text=True, encoding="utf-8", errors="replace")

    # 不能只看「有没有触发重试」——那只能证明重试跑了，证明不了界面回来了。
    # 用截图的内容方差判断：空白错误页几乎是纯色（方差≈0），正常界面有大量层次。
    png = os.path.join(OUT, "app-shot.png")
    code = ("import sys;from PIL import Image,ImageStat;"
            "im=Image.open(r'" + png + "').convert('L');"
            "print('%.2f' % ImageStat.Stat(im).stddev[0])")
    check = subprocess.run(
        ["C:/Users/JinYuDream/.workbuddy/binaries/python/envs/default/Scripts/python.exe", "-c", code],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    stddev = float(check.stdout.strip() or 0)
    print("  截图内容方差（越大越像正常界面）：%.2f" % stddev)

    tail = [line for line in read_log().splitlines() if "重试" in line or "载入界面" in line][-8:]
    print("  日志（重试相关，最后 8 条）：")
    for line in tail:
        print("    " + line)
    print()

    recovered = stddev > 12
    if not retried:
        print("结论：!! 未触发重试，需排查")
    elif recovered:
        print("结论：自愈成功（重试后界面已恢复，方差 %.2f）" % stddev)
    else:
        print("结论：!! 触发了重试但界面仍空白（方差 %.2f），需排查" % stddev)
    return 0 if (retried and recovered) else 1


if __name__ == "__main__":
    sys.exit(main())
