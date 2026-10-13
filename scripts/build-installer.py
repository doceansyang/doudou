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
import glob
import json
import os
import re
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


def read_version():
    """版本号的唯一来源：仓库根的 package.json（scripts/release.py 负责改它）。

    服务端「检查更新」也读安装目录里的 package.json 来知道自己是哪个版本，
    所以这个值必须一路走到发行包里，不能在这里另写一份。
    """
    with open(os.path.join(PROJECT, "package.json"), encoding="utf-8") as handle:
        version = json.load(handle).get("version", "").strip()
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        raise SystemExit("package.json 里的 version 不合法：%r（应形如 2.0.0）" % version)
    return version


VERSION = read_version()
OUT_SETUP = os.path.join(BASE, "JinyuTV-%s-Setup.exe" % VERSION)

# 运行期真正需要的 RPA 文件（服务端会按 <安装目录>/scripts/doubao-rpa-service.ts 拉起）
# RPA 运行必需的脚本。⚠️ 必须与 dev-update-both.py 的 RPA_SCRIPTS 保持一致：
# 漏一个，发行版里 RPA 就会因为 import 失败而**整个起不来**（去水印那两个脚本踩过）。
RPA_SCRIPTS = [
    "doubao-rpa-service.ts",
    "doubao-rpa-core.ts",
    "doubao-accounts.ts",
    "doubao-deshadow.ts",
    "doubao-watermark.ts",
    "deshadow-doubao.py",
]

# 授权运行时（**必须**打进安装包，否则客户装完无法激活，软件直接打不开）。
# 只放运行时必需的两个；签发用的 make-license.py / sign.ts 绝不能打进去
# —— 那是作者自己的工具（见 sanitize() 里的移除与私钥兜底检查）。
LICENSE_RUNTIME = ["license-core.ts", "license-bridge.ts"]

# 不打进发行包的名字特征
SKIP_SUFFIX = (".bak", ".bak2", ".bak3", ".prebuild", ".orig", ".manual", ".empty", ".log")

# data/ 下的开发过程遗留目录（探针备份、旧工作区迁移残留）—— 出厂不带，见 sanitize()
STALE_DATA_DIRS = ("_probe-archive", "_probe-archive-remove-me", "_workspace-legacy")
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

    # 3) scripts/ 只保留 RPA 运行必需 + 授权运行时
    dst_scripts = os.path.join(stage, "scripts")
    os.makedirs(dst_scripts, exist_ok=True)
    for name in RPA_SCRIPTS + LICENSE_RUNTIME:
        src = os.path.join(SOFTWARE, "scripts", name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dst_scripts, name))
    dst_license = os.path.join(dst_scripts, "license")
    os.makedirs(dst_license, exist_ok=True)
    for name in LICENSE_RUNTIME:
        src = os.path.join(SOFTWARE, "scripts", "license", name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dst_license, name))
        else:
            # 缺了它整包就废了（客户无法激活 → 软件打不开），必须在打包阶段就报错
            raise SystemExit("!! 缺少授权运行时 %s，软件将无法激活，请先跑 dev-update.py 同步" % name)
    print("  scripts/      %d 个 RPA 文件 + %d 个授权运行时"
          % (len(RPA_SCRIPTS), len(os.listdir(dst_license))))

    # 4) tools/：只带「豆包账号桥」浏览器扩展（客户要在自己的浏览器里加载它）。
    #    ⚠️ 不带 tools/ 下的其他开发工具，尤其**绝不带 .pem 私钥** —— 那是扩展的签名身份，
    #    泄露出去别人就能顶着同一个扩展 ID 发布东西。
    ext_dir = os.path.join(SOFTWARE, "tools", "doubao-cookie-bridge")
    if os.path.isdir(ext_dir):
        n = copy_tree(ext_dir, os.path.join(stage, "tools", "doubao-cookie-bridge"))
        print("  %-13s %d 个文件" % ("tools/ext", n))
    else:
        print("  %-13s !! 缺失（客户将无法一键同步浏览器账号）" % "tools/ext")
    ext_crx = os.path.join(SOFTWARE, "tools", "doubao-cookie-bridge.crx")
    if os.path.isfile(ext_crx):
        os.makedirs(os.path.join(stage, "tools"), exist_ok=True)
        shutil.copy2(ext_crx, os.path.join(stage, "tools", "doubao-cookie-bridge.crx"))
        print("  %-13s 已复制" % "tools/crx")

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

    # 开发过程遗留：探针备份目录、旧工作区迁移残留、settings 的各种历史副本。
    # 前两类是 2026-10-13 发 3.0.0 时发现的 —— `_workspace-legacy/` 里还留着
    # 1.4MB 的生成视频，等于把打包机的私有素材塞进了发行包；`settings.json.pre-linke`
    # 则是一份**净化前**的设置快照（含打包机绝对路径与旧域名），同样不能出厂。
    # 用明确名单而不是"所有 _ 开头目录"，避免误伤 data 下将来可能有用的下划线目录。
    stale_dirs = []
    for name in STALE_DATA_DIRS:
        path = os.path.join(stage, "data", name)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
            stale_dirs.append(name)
    if stale_dirs:
        print("  移除遗留目录：%s" % "、".join(stale_dirs))

    stale_files = []
    for name in sorted(glob.glob(os.path.join(stage, "data", "settings.json.*"))):
        os.remove(name)
        stale_files.append(os.path.basename(name))
    if stale_files:
        print("  移除设置历史副本：%s" % "、".join(stale_files))

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

    # 授权：绝不能带任何已激活信息 —— 每台电脑必须自己输入授权码。
    lic = os.path.join(stage, "data", "license.json")
    if os.path.isfile(lic):
        os.remove(lic)
        print("  移除本机授权文件（每台电脑需自行激活）")

    # 授权**签发工具**：make-license.py / sign.ts 只给作者自己用。
    # 打给客户等于把签发能力送出去（虽然私钥不在包里，但工具本身不该外流）。
    removed_tools = []
    for rel in ("scripts/license/make-license.py", "scripts/license/sign.ts"):
        path = os.path.join(stage, rel.replace("/", os.sep))
        if os.path.isfile(path):
            os.remove(path)
            removed_tools.append(os.path.basename(rel))
    if removed_tools:
        print("  移除授权签发工具：%s（仅作者本机保留）" % "、".join(removed_tools))

    # 兜底：任何形态的密钥文件都不该出现在安装包里
    leaked = []
    for dirpath, _, filenames in os.walk(stage):
        for name in filenames:
            if name.endswith((".jwk", ".pem")) or name.lower().startswith("private"):
                leaked.append(os.path.relpath(os.path.join(dirpath, name), stage))
    if leaked:
        raise SystemExit(
            "!! 安装包里出现了疑似私钥文件，已中止打包：%s\n"
            "   （私钥绝不能随软件分发，请检查打包流程）" % "、".join(leaked)
        )
    print("  私钥检查：未发现 .jwk/.pem/private* 文件 ✓")

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

    # 0) 版本号落到绿色版根目录：服务端「检查更新」读的就是这里的 package.json。
    #    不覆盖这一份的话，装出来的软件会永远以为自己还是旧版本。
    shutil.copy2(os.path.join(PROJECT, "package.json"), os.path.join(SOFTWARE, "package.json"))
    print("--- 版本：%s（已同步 package.json 到绿色版）" % VERSION)

    # 1) 编译启动器（同时放进绿色版与暂存目录）——走 compile-launcher.py，
    #    它会一并铺好 WebView2 的三支依赖，避免这里重复维护引用参数
    run("编译启动器 JinyuTV.exe（内嵌 WebView2 窗口）",
        [sys.executable, os.path.join(SCRIPTS, "compile-launcher.py"), SOFTWARE])
    print("  -> %.1f KB" % (os.path.getsize(os.path.join(SOFTWARE, LAUNCHER_EXE)) / 1024))

    # 2) 组装净化后的发行目录
    stage = build_stage()

    # 3) 编译安装包（用净化目录作为源；版本号传进 NSIS，安装包文件名与卸载项都靠它）
    run("编译安装包", [MAKENSIS, "/INPUTCHARSET", "UTF8", "/DAPP_VERSION=" + VERSION,
                       "/DSOURCE_DIR=" + stage.replace("\\", "/"), NSI], cwd=SCRIPTS)
    if os.path.exists(OUT_SETUP):
        print("\n===== 完成 =====")
        print("  安装程序：%s" % OUT_SETUP)
        print("  大小    ：%.1f MB" % (os.path.getsize(OUT_SETUP) / 1048576))
    else:
        raise SystemExit("!! 未生成安装包，请检查上面的 NSIS 输出")


if __name__ == "__main__":
    sys.exit(main())
