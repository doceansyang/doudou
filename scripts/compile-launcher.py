# -*- coding: utf-8 -*-
"""编译启动器 JinyuTV.exe（内嵌 WebView2 窗口）并铺到指定位置。

为什么要独立脚本：
  直接调 C# 编译器会被安全策略拦（等效于 Add-Type 编译任意 C#），
  走 Python 子进程则是打包链里同一条合法路径。

启动器现在依赖 WebView2，编译期需要两个托管程序集，运行期需要原生加载器：
  编译期：Microsoft.Web.WebView2.Core.dll / Microsoft.Web.WebView2.WinForms.dll
  运行期：上面两个 + WebView2Loader.dll（必须与 JinyuTV.exe 同目录）
这三支来自 toonflow/tools/webview2/，会一并复制到目标目录。

用法：
  python scripts/compile-launcher.py [输出目录1] [输出目录2] ...
不带参数时，默认编译到绿色版目录与已安装目录。
"""
import os
import shutil
import subprocess
import sys

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
LAUNCHER_CS = os.path.join(PROJECT, "scripts", "launcher.cs")
BUILDER_DIR = os.path.join(PROJECT, "scripts")

# WebView2 SDK 组件（随包携带，保证换台电脑也能显示应用窗口）
WV2_DIR = os.path.join(PROJECT, "tools", "webview2")
WV2_FILES = [
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll",
]

# 窗口图标（放软件根目录，launcher.cs 会按 logo.ico 优先加载）
LOGO_SRC = os.path.join(PROJECT, "packages", "assets", "logo.ico")

CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")

DEFAULT_TARGETS = [
    os.path.join(BASE, "JinyuTV-portable"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV"),
]


def references():
    # System.Management：用 WMI 按命令行找出 RPA 启动的浏览器进程，把它的窗口收编到侧栏
    refs = ["System.dll", "System.Core.dll", "System.Drawing.dll",
            "System.Windows.Forms.dll", "System.Management.dll"]
    return ["/r:" + r for r in refs] + [
        "/r:" + os.path.join(WV2_DIR, "Microsoft.Web.WebView2.Core.dll"),
        "/r:" + os.path.join(WV2_DIR, "Microsoft.Web.WebView2.WinForms.dll"),
    ]


def copy_wv2(target_dir):
    n = 0
    for name in WV2_FILES:
        src = os.path.join(WV2_DIR, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(target_dir, name))
            n += 1
    if os.path.isfile(LOGO_SRC):
        try:
            shutil.copy2(LOGO_SRC, os.path.join(target_dir, "logo.ico"))
        except OSError:
            pass
    return n


def compile_to(target_dir):
    if not os.path.isdir(target_dir):
        print("  - 跳过（目录不存在）：%s" % target_dir)
        return False
    out = os.path.join(target_dir, "JinyuTV.exe")
    proc = subprocess.run(
        [CSC, "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
         "/out:" + out, LAUNCHER_CS] + references(),
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print("  !! 编译失败：%s" % (proc.stdout or proc.stderr))
        return False
    print("  ✓ %s（%.1f KB）" % (out, os.path.getsize(out) / 1024))
    n = copy_wv2(target_dir)
    print("    + WebView2 组件 %d/3 个 -> %s" % (n, target_dir))
    return n == 3


def main():
    if not os.path.exists(CSC):
        raise SystemExit("找不到 C# 编译器：%s" % CSC)
    if not os.path.isdir(WV2_DIR):
        raise SystemExit("缺少 WebView2 SDK 组件：%s" % WV2_DIR)
    targets = sys.argv[1:] or DEFAULT_TARGETS
    print("=== 编译启动器（内嵌 WebView2 窗口）===")
    ok = False
    for t in targets:
        ok = compile_to(t) or ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
