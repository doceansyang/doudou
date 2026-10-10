# -*- coding: utf-8 -*-
"""把豆包自动化浏览器窗口移到屏幕内并前置（纯 ctypes，无编译）。"""
import ctypes
import ctypes.wintypes as wt
import json
import sys

user32 = ctypes.windll.user32

SW_RESTORE = 9
SW_SHOW = 5
SWP_SHOWWINDOW = 0x0040
SWP_NOZORDER = 0x0004

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def get_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def enum_windows():
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
            "hwnd": int(hwnd),
            "pid": int(pid.value),
            "title": t,
            "rect": [r.left, r.top, r.right, r.bottom],
            "minimized": bool(user32.IsIconic(hwnd)),
        })
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def screen_size():
    user32.SetProcessDPIAware()
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    return w, h


user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wt.UINT]
HWND_TOPMOST = wt.HWND(-1)


def move(hwnd, x, y, cx, cy, topmost=True):
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.ShowWindow(hwnd, SW_SHOW)
    after = HWND_TOPMOST if topmost else wt.HWND(0)
    user32.SetWindowPos(hwnd, after, x, y, cx, cy, SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return [r.left, r.top, r.right, r.bottom]


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "豆包"
    wins = enum_windows()
    sw, sh = screen_size()
    report = {"screen": [sw, sh], "matched": [], "all_doubao": []}
    for w in wins:
        if "豆包" in w["title"]:
            report["all_doubao"].append(w)
    cands = [w for w in report["all_doubao"] if target in w["title"]] if target else report["all_doubao"]
    if not cands:
        cands = report["all_doubao"]
    # 多个候选时优先"生成视频"标题的窗口
    gen = [w for w in cands if "生成视频" in w["title"]]
    if gen:
        cands = gen
    x = max(20, sw // 2 + 20)
    cx = min(1240, sw - x - 20)
    cy = min(960, sh - 60)
    for w in cands:
        w["after"] = move(w["hwnd"], x, 16, cx, cy)
        report["matched"].append(w)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
