# -*- coding: utf-8 -*-
"""写出 start-server.bat（CRLF + 纯 ASCII 注释）。

为什么要专门用一个脚本写：
  - 批处理必须是 **CRLF** 换行。LF 会导致括号块解析失败，报 `'""' is not recognized...`
  - 注释保持 ASCII，避免在不同代码页的 cmd 下出现乱码被当成命令执行
这两点都是「本机看着没事、换台电脑就失败」的典型坑，所以固化下来而不是手改。
"""
import os
import sys

CONTENT = r"""@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ---------------------------------------------------------------- runtime
set "BUN=%~dp0runtime\bun.exe"
if not exist "%BUN%" set "BUN=bun"

rem ---------------------------------------------------------------- required env
rem Desktop/local mode. Without this the server validates workspaces as a
rem "server deployment" and rejects any local folder with 403, which makes the
rem frontend request fail and takes the process down.
set "toonflowDesktop=1"
rem Pin the data directory to this install folder so any install path works.
set "TOONFLOW_DATA_DIR=%~dp0data"
rem Local requests must bypass any system HTTP proxy.
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

if not exist "logs" mkdir "logs"

rem ---------------------------------------------------------------- bootstrap
rem Rewrite paths that were captured on the build machine (workspace folder,
rem doubao browser profile) to this machine. Idempotent, safe to run every time.
if exist "%~dp0JinyuTV.exe" "%~dp0JinyuTV.exe" --bootstrap-only

echo [%date% %time%] JinyuTV server start >> "logs\server.log"
"%BUN%" build\server\index.js >> "logs\server.log" 2>&1
"""

TARGETS = [
    r"C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV"),
    r"C:/Users/JinYuDream/WorkBuddy/豆包画布开发/_installer-stage",
]


def main():
    wrote = 0
    for root in TARGETS:
        if not os.path.isdir(root):
            print("  跳过（不存在）：%s" % root)
            continue
        path = os.path.join(root, "start-server.bat")
        with open(path, "w", encoding="ascii", newline="\r\n") as fh:
            fh.write(CONTENT)
        size = os.path.getsize(path)
        print("  ✓ %s（%d 字节，CRLF）" % (path, size))
        wrote += 1
    return 0 if wrote else 1


if __name__ == "__main__":
    sys.exit(main())
