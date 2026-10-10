# -*- coding: utf-8 -*-
"""生成 JinyuTV 的 Windows 安装程序（含「出厂净化」）。

步骤：
  1. 用 .NET Framework 的 C# 编译器把 launcher.cs 编成 JinyuTV.exe（无控制台窗口的启动器）
  2. 组装**发行暂存目录**（净化版）：只带运行必需的文件；不带打包机的豆包账号、
     调试脚本、日志、备份文件
  3. 用 NSIS 编译 installer.nsi，产出 JinyuTV-2.0.0-Setup.exe

为什么自己写这一套而不走项目的 ElectroBun 打包：
  ElectroBun 的构建链（Hutch → Cottontail → bun toolchain）必须从 GitHub Releases
  拉工具链，而本机直连 GitHub 的大文件下载会卡死（40MB 的包 150 秒下不完），
  hutch 又不支持配置国内镜像。所以直接用 NSIS 打标准安装包。

出厂净化规则（保证「换台电脑装上就能用」）：
  - data/doubao/accounts.json -> []      同事用自己的豆包账号，出厂不带任何账号
  - data/workspaces           -> 清空    开发者的个人画布/素材不分发（前端会自动新建「画布1」）
  - data/settings.json        -> 移除记录打包机绝对路径的项目条目
                                         由启动器在首次运行时按本机路径自动重建项目
  - scripts/                  -> 只保留 RPA 运行必需的三支文件
  - 排除 logs/、*.orig、*.bak*、临时截图

用法：
  python scripts/build-installer.py
"""
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
SOFTWARE = os.path.join(BASE, "JinyuTV-portable")
SCRIPTS = os.path.join(PROJECT, "scripts")
STAGE = os.path.join(BASE, "_installer-stage")

CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
MAKENSIS = os.environ.get("NSIS_PATH", r"C:/Program Files (x86)/NSIS/makensis.exe")

LAUNCHER_EXE = "JinyuTV.exe"
# 启动器的 WebView2 依赖（必须与 exe 同目录；缺一个窗口就起不来）
WV2_FILES = [
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll",
]
NSI = os.path.join(SCRIPTS, "installer.nsi")
OUT_SETUP = os.path.join(BASE, "JinyuTV-2.0.0-Setup.exe")

# 运行期真正需要的 RPA 文件（服务端会按 <安装目录>/scripts/doubao-rpa-service.ts 拉起）
RPA_SCRIPTS = ["doubao-rpa-service.ts", "doubao-rpa-core.ts", "doubao-accounts.ts"]

# 不打进发行包的名字特征
SKIP_SUFFIX = (".bak", ".bak2", ".bak3", ".prebuild", ".orig", ".manual", ".empty", ".log")
SKIP_NAMES = {"logs", "_junk-backups", ".rebrand-backup"}


def run(label, args, cwd=None):
    print("\n--- %s" % label)
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.stdout and proc.stdout.strip():
        print(proc.stdout.strip()[-2000:])
    if proc.stderr and proc.stderr.strip():
        print("[stderr] " + proc.stderr.strip()[-1500:])
    if proc.returncode != 0:
        raise SystemExit("!! 失败：%s（退出码 %d）" % (label, proc.returncode))
    return proc


def stop_services():
    """打包前停掉服务：data/ 与 logs/ 里的文件会被运行中的进程占用，NSIS 读不到就报错。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace").stdout
    except OSError:
        return
    pids = set()
    for line in out.splitlines():
        if ("LISTENING" in line) and (":3000" in line or ":18077" in line):
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        print("  停止 PID=%s（占用 3000/18077）" % pid)
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, text=True)


# ------------------------------------------------------------------ 暂存目录组装

def fresh_stage():
    """新开一个干净的暂存目录（不删除旧目录，规避批量删除守卫）。"""
    if os.path.isdir(STAGE):
        old = "%s-old-%s" % (STAGE, time.strftime("%H%M%S"))
        os.rename(STAGE, old)
        print("  旧暂存目录已改名为：%s" % os.path.basename(old))
    os.makedirs(STAGE, exist_ok=True)
    return STAGE


def copy_tree(src, dst):
    """复制目录树，跳过日志与备份类文件。"""
    total = 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_NAMES and not d.endswith(SKIP_SUFFIX)]
        rel = os.path.relpath(dirpath, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for name in filenames:
            if name.endswith(SKIP_SUFFIX):
                continue
            s, t = os.path.join(dirpath, name), os.path.join(target, name)
            try:
                shutil.copy2(s, t)
                total += 1
            except OSError:
                pass
    return total


def build_stage():
    print("\n--- 组装发行暂存目录")
    stage = fresh_stage()

    # 1) 运行产物 + 数据 + 运行时 + 浏览器驱动
    for name in ["build", "data", "runtime", "node_modules"]:
        src = os.path.join(SOFTWARE, name)
        if not os.path.isdir(src):
            print("  !! 缺少 %s，跳过" % name)
            continue
        n = copy_tree(src, os.path.join(stage, name))
        print("  %-13s %d 个文件" % (name, n))

    # 2) 根文件（含启动器的 WebView2 依赖与窗口图标）
    for name in (["package.json", "start-server.bat", "启动JinyuTV.bat", "logo.ico", LAUNCHER_EXE]
                 + WV2_FILES):
        src = os.path.join(SOFTWARE, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(stage, name))
            print("  %-13s 已复制" % name)
        else:
            print("  %-13s !! 缺失" % name)

    # 3) scripts/ 只保留 RPA 运行必需
    dst_scripts = os.path.join(stage, "scripts")
    os.makedirs(dst_scripts, exist_ok=True)
    for name in RPA_SCRIPTS:
        src = os.path.join(SOFTWARE, "scripts", name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dst_scripts, name))
    print("  scripts/      %d 个 RPA 文件" % len(os.listdir(dst_scripts)))

    sanitize(stage)
    return stage


def sanitize(stage):
    """出厂净化：不带打包机的账号、不带打包机的绝对路径、不带开发者的个人画布。"""
    print("\n--- 出厂净化")

    # 账号：清空，同事用自己的豆包账号（界面里「新增账号」+ 扫码登录）
    acc = os.path.join(stage, "data", "doubao", "accounts.json")
    os.makedirs(os.path.dirname(acc), exist_ok=True)
    with open(acc, "w", encoding="utf-8") as fh:
        json.dump([], fh, ensure_ascii=False)
    print("  accounts.json -> []（不带任何豆包账号）")

    # 个人画布与素材：属于开发者本机的私有内容，绝不能随安装包分发。
    # 移除后工作区为空 —— 前端在「一张画布都没有」时会自动新建「画布1」
    # （canvasMenu.vue: 列表为空 -> createCanvasFile(directory, "画布1")），
    # 所以同事装完打开就是一张干净的新画布，不需要手工建。
    ws = os.path.join(stage, "data", "workspaces")
    if os.path.isdir(ws):
        moved = 0
        if os.listdir(ws):
            hold = os.path.join(BASE, "_excluded-user-data", time.strftime("%m%d-%H%M%S"))
            os.makedirs(hold, exist_ok=True)
            for name in os.listdir(ws):
                shutil.move(os.path.join(ws, name), os.path.join(hold, name))
                moved += 1
        os.makedirs(ws, exist_ok=True)
        print("  移除个人画布/素材：%d 项（已移到 _excluded-user-data/，未删除）" % moved)

    # 设置：移除记录打包机绝对路径的项目条目；匿名统计 id 换新
    sp = os.path.join(stage, "data", "settings.json")
    if os.path.isfile(sp):
        with open(sp, encoding="utf-8") as fh:
            cfg = json.load(fh)
        settings = cfg.setdefault("settings", {})
        stores = settings.get("stores")
        if isinstance(stores, dict):
            removed = stores.pop("toonflow.projectList", None)
            print("  移除打包机项目记录：%s" % ("是" if removed else "无"))
        privacy = settings.get("privacy")
        if isinstance(privacy, dict):
            privacy["anonymousId"] = str(uuid.uuid4())
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        print("  settings.json 已净化（启动器首次运行会按本机路径重建项目）")

    # 兜底：清掉可能被带进来的 .orig
    for dirpath, _, filenames in os.walk(stage):
        for name in filenames:
            if name.endswith(".orig"):
                os.remove(os.path.join(dirpath, name))

    # WebView2 的浏览器缓存（data/webview2）：运行时生成，体量大且与本机绑定，
    # 绝不能打进发行包
    wv2cache = os.path.join(stage, "data", "webview2")
    if os.path.isdir(wv2cache):
        hold = os.path.join(BASE, "_excluded-user-data", "webview2-" + time.strftime("%m%d-%H%M%S"))
        os.makedirs(os.path.dirname(hold), exist_ok=True)
        try:
            shutil.move(wv2cache, hold)
            print("  移除 WebView2 运行缓存（已移到 _excluded-user-data/）")
        except OSError:
            print("  ! WebView2 运行缓存移除失败（忽略）")


# ------------------------------------------------------------------ 主流程

def main():
    if not os.path.exists(CSC):
        raise SystemExit("找不到 C# 编译器：%s" % CSC)
    if not os.path.exists(MAKENSIS):
        raise SystemExit("找不到 NSIS：%s（可执行 winget install NSIS.NSIS）" % MAKENSIS)
    if not os.path.isdir(SOFTWARE):
        raise SystemExit("找不到绿色版目录：%s" % SOFTWARE)

    print("--- 停止正在运行的软件（释放被占用的文件）")
    stop_services()

    # 1) 编译启动器（同时放进绿色版与暂存目录）——走 compile-launcher.py，
    #    它会一并铺好 WebView2 的三支依赖，避免这里重复维护引用参数
    run("编译启动器 JinyuTV.exe（内嵌 WebView2 窗口）",
        [sys.executable, os.path.join(SCRIPTS, "compile-launcher.py"), SOFTWARE])
    print("  -> %.1f KB" % (os.path.getsize(os.path.join(SOFTWARE, LAUNCHER_EXE)) / 1024))

    # 2) 组装净化后的发行目录
    stage = build_stage()

    # 3) 编译安装包（用净化目录作为源）
    run("编译安装包", [MAKENSIS, "/INPUTCHARSET", "UTF8",
                       "/DSOURCE_DIR=" + stage.replace("\\", "/"), NSI], cwd=SCRIPTS)
    if os.path.exists(OUT_SETUP):
        print("\n===== 完成 =====")
        print("  安装程序：%s" % OUT_SETUP)
        print("  大小    ：%.1f MB" % (os.path.getsize(OUT_SETUP) / 1048576))
    else:
        raise SystemExit("!! 未生成安装包，请检查上面的 NSIS 输出")


if __name__ == "__main__":
    sys.exit(main())
