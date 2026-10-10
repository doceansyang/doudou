# -*- coding: utf-8 -*-
"""组装 JinyuTV 绿色版（解压即用，不需要安装程序）。

包含：
  build/            已构建的前端与服务端产物（含 JinyuTV 品牌与新 logo）
  scripts/          豆包 RPA 服务脚本
  package.json      供 bun 解析工程根
  data/             运行时数据（保留豆包账号登录态与设置）
  启动JinyuTV.bat 一键启动
  runtime/bun.exe   bun 运行时（绿色版自带，免装）

不包含：通用 node_modules（服务端是 self-contained bundle，运行不需要）。
例外：node_modules/playwright + playwright-core 必须携带（RPA 运行时动态 import，见下）。
"""
import os
import shutil
import sys
import time
import zipfile

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
OUT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable"
ZIP = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable.zip"

SKIP_DIRS = {"node_modules", ".git", ".rebrand-backup", "logs"}
SKIP_SUFFIX = (".bak", ".prebuild", ".manual", ".empty")


def copy_tree(src, dst, skip_dirs=SKIP_DIRS):
    total = 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames
                       if d not in skip_dirs and not d.endswith(SKIP_SUFFIX)]
        rel = os.path.relpath(dirpath, src)
        target_dir = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target_dir, exist_ok=True)
        for name in filenames:
            if name.endswith(SKIP_SUFFIX):
                continue
            s, d = os.path.join(dirpath, name), os.path.join(target_dir, name)
            try:
                shutil.copy2(s, d)
                total += os.path.getsize(d)
            except OSError:
                pass
    return total


BAT = """@echo off
chcp 65001 >nul
title JinyuTV
cd /d "%~dp0"

if not exist "build\\server\\index.js" (
  echo [ERROR] build\\server\\index.js not found. Current dir: %CD%
  pause
  exit /b 1
)

echo 正在启动 JinyuTV…
echo   主服务端口 3000；启动后会自动拉起豆包 RPA 服务（端口 18077）。

rem 后端逻辑统一放在 start-server.bat（环境变量、本机适配、日志都在那里）
start "JinyuTV 服务 (:3000)" /min cmd /c start-server.bat

timeout /t 8 >nul
start "" "http://localhost:3000/#/workspace"
"""

# 后端启动脚本。硬性要求（都是踩过的坑）：
#   - CRLF 换行：LF 会让括号块解析失败
#   - 纯 ASCII 注释：避免不同代码页的 cmd 把注释字节误认成命令
#   - 必须 set toonflowDesktop=1：否则服务按「服务器部署」校验工作区，一律 403 且会把进程带崩
#   - 必须 set TOONFLOW_DATA_DIR：安装路径任意时，保证数据目录就是本目录
START_SERVER_BAT = r"""@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ---------------------------------------------------------------- runtime
set "BUN=%~dp0runtime\bun.exe"
if not exist "%BUN%" set "BUN=bun"

rem ---------------------------------------------------------------- required env
rem Desktop/local mode. Without this the server validates workspaces as a
rem "server deployment" and rejects any local folder with 403.
set "toonflowDesktop=1"
rem Pin the data directory to this install folder so any install path works.
set "TOONFLOW_DATA_DIR=%~dp0data"
rem Local requests must bypass any system HTTP proxy.
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

if not exist "logs" mkdir "logs"

rem ---------------------------------------------------------------- bootstrap
rem Rewrite paths captured on the build machine (workspace folder, doubao
rem browser profile) to this machine. Idempotent, safe to run every time.
if exist "%~dp0JinyuTV.exe" "%~dp0JinyuTV.exe" --bootstrap-only

echo [%date% %time%] JinyuTV server start >> "logs\server.log"
"%BUN%" build\server\index.js >> "logs\server.log" 2>&1
"""


def main():
    print("源目录: %s" % PROJECT)
    if os.path.isdir(OUT):
        # 不删除（本会话有批量删除守卫），改用带序号的目录
        idx = 2
        while os.path.isdir(OUT + str(idx)):
            idx += 1
        out = OUT + str(idx)
    else:
        out = OUT
    print("输出目录: %s" % out)

    os.makedirs(out, exist_ok=True)

    # 核心产物
    for name in ["build", "scripts", "data"]:
        src = os.path.join(PROJECT, name)
        if os.path.isdir(src):
            size = copy_tree(src, os.path.join(out, name))
            print("  %-10s -> %.1f MB" % (name, size / 1048576))

    # 工程根文件
    for name in ["package.json"]:
        src = os.path.join(PROJECT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(out, name))
            print("  %-10s 已复制" % name)

    # bun 运行时
    runtime = os.path.join(out, "runtime")
    os.makedirs(runtime, exist_ok=True)
    if os.path.exists(BUN):
        shutil.copy2(BUN, os.path.join(runtime, "bun.exe"))
        print("  runtime/bun.exe 已复制（%.1f MB）" % (os.path.getsize(os.path.join(runtime, "bun.exe")) / 1048576))

    # playwright 运行库：RPA 里是**运行时动态 import**，不随 node_modules 一起复制的话，
    # 只能靠本机 bun 全局缓存解析 —— 换干净机器就失效（且服务健康检查仍显示 ok，隐蔽）。    nm = os.path.join(out, "node_modules")
    os.makedirs(nm, exist_ok=True)
    for pkg in ["playwright", "playwright-core"]:
        src = os.path.join(PROJECT, "node_modules", pkg)
        if not os.path.exists(src):
            print("  !! 项目里找不到 %s，RPA 将依赖外部环境" % pkg)
            continue
        dst = os.path.join(nm, pkg)
        if not os.path.exists(dst):
            shutil.copytree(os.path.realpath(src), dst, symlinks=False,
                            ignore_dangling_symlinks=True)
        size = sum(os.path.getsize(os.path.join(dp, f))
                   for dp, _, fs in os.walk(dst) for f in fs
                   if os.path.exists(os.path.join(dp, f)))
        print("  node_modules/%-16s -> %.1f MB" % (pkg, size / 1048576))

    # 启动脚本
    with open(os.path.join(out, "启动JinyuTV.bat"), "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(BAT)
    print("  启动JinyuTV.bat 已生成")

    # 后端启动脚本：必须是 **CRLF + 纯 ASCII 注释**，否则在部分机器的 cmd 下解析失败
    # （LF 换行会让括号块报 `'""' is not recognized...`）。启动器就是调它来起服务的。
    with open(os.path.join(out, "start-server.bat"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write(START_SERVER_BAT)
    print("  start-server.bat 已生成（CRLF）")

    # 出厂净化：个人画布与素材不分发（属于开发者本机私有内容）。
    # 清空后工作区为空 —— 前端在「一张画布都没有」时会自动新建「画布1」。
    ws = os.path.join(out, "data", "workspaces")
    if os.path.isdir(ws):
        moved = 0
        if os.listdir(ws):
            hold = os.path.join(os.path.dirname(PROJECT),
                                "_excluded-user-data", time.strftime("%m%d-%H%M%S"))
            os.makedirs(hold, exist_ok=True)
            for name in os.listdir(ws):
                shutil.move(os.path.join(ws, name), os.path.join(hold, name))
                moved += 1
        os.makedirs(ws, exist_ok=True)
        print("  个人画布/素材已移出发行版：%d 项（未删除）" % moved)

    # 打包 zip
    print("\n正在打包 zip…")
    count = 0
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for dirpath, dirnames, filenames in os.walk(out):
            dirnames[:] = [d for d in dirnames if not d.endswith(SKIP_SUFFIX)]
            for name in filenames:
                full = os.path.join(dirpath, name)
                zf.write(full, os.path.relpath(full, os.path.dirname(out)))
                count += 1
    print("  %s（%d 个文件，%.1f MB）" % (ZIP, count, os.path.getsize(ZIP) / 1048576))


if __name__ == "__main__":
    sys.exit(main())
