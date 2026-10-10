# -*- coding: utf-8 -*-
"""列出当前所有可见顶层窗口（标题/进程/PID）。"""
import ctypes
import ctypes.wintypes as wt
import json

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def get_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


out = []


def cb(hwnd, lparam):
    if not user32.IsWindowVisible(hwnd):
        return True
    t = get_title(hwnd)
    if not t:
        return True
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    out.append({
        "hwnd": int(hwnd), "pid": int(pid.value), "title": t,
        "rect": [r.left, r.top, r.right, r.bottom],
        "minimized": bool(user32.IsIconic(hwnd)),
    })
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)
print(json.dumps(out, ensure_ascii=False, indent=1))
