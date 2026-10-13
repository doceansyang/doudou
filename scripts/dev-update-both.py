# -*- coding: utf-8 -*-
"""开发循环（双实例版）：构建 web -> 停服 -> 重编启动器(两个实例) -> 同步 web 到两个实例
-> 重启「安装版」-> 自检。

为什么需要它：`dev-update.py` 只同步绿色版 JinyuTV-portable，而用户实际在用的是
安装版 %LOCALAPPDATA%\\Programs\\JinyuTV —— 只跑 dev-update 的话改动对用户等于没生效。
另外 dev-update 的重启会把绿色版也拉起来，3000 端口归属会变，验证时容易误判。

用法：python scripts/dev-update-both.py
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
PROJECT = os.path.join(BASE, "toonflow")
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
INSTALLED = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")
PORTABLE = os.path.join(BASE, "JinyuTV-portable")
TARGETS = [PORTABLE, INSTALLED]
SKIP = (".bak", ".prebuild", ".manual", ".empty")
# RPA（豆包自动化）在实例里跑的是 scripts/ 下的这些源码，白名单同步（别铺整个目录）。
RPA_SCRIPTS = (
    "doubao-accounts.ts",
    "doubao-rpa-core.ts",
    "doubao-rpa-service.ts",
    "doubao-watermark.ts",
    "doubao-deshadow.ts",
    "deshadow-doubao.py",
)

NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_env():
    root = os.environ.get("SystemRoot", r"C:\Windows")
    head = [os.path.join(root, "System32"), root, os.path.dirname(BUN)]
    env = dict(os.environ, NODE_ENV="production",
               PATH=os.pathsep.join(head + [os.environ.get("PATH", "")]))
    for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
        env.pop(key, None)
    return env


def stash_old_web(root):
    web = os.path.join(root, "build", "web")
    if not os.path.isdir(web):
        return
    hold = os.path.join(root, "_build-cache", "web-%s" % time.strftime("%m%d-%H%M%S"))
    os.makedirs(os.path.dirname(hold), exist_ok=True)
    shutil.move(web, hold)
    print("--- 旧 web 已挪走：%s" % hold)


def build_web():
    stash_old_web(PROJECT)
    proc = subprocess.run([BUN, "run", "--filter", "@toonflow/web", "build"],
                          cwd=PROJECT, env=build_env(), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    for line in (proc.stdout or "").strip().splitlines()[-6:]:
        print("    " + line)
    if proc.returncode != 0:
        print((proc.stderr or "")[-1500:])
        raise SystemExit("!! web 构建失败")


def build_pkg(name: str):
    """只重建某个包（server / nodes / tools / ext）。"""
    proc = subprocess.run([BUN, "run", "--filter", name, "build"],
                          cwd=PROJECT, env=build_env(), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    for line in (proc.stdout or "").strip().splitlines()[-6:]:
        print("    " + line)
    if proc.returncode != 0:
        print((proc.stderr or "")[-1500:])
        raise SystemExit("!! %s 构建失败" % name)


def sync_dir(rel):
    """把一个构建产物目录同步到两个实例（逐文件覆盖，不删）。"""
    src = os.path.join(PROJECT, rel)
    for root in TARGETS:
        if not os.path.isdir(root):
            continue
        total = 0
        for dirpath, dirnames, filenames in os.walk(src):
            dirnames[:] = [d for d in dirnames if not d.endswith(SKIP)]
            r = os.path.relpath(dirpath, src)
            target_dir = os.path.join(root, rel) if r == "." else os.path.join(root, rel, r)
            os.makedirs(target_dir, exist_ok=True)
            for name in filenames:
                if name.endswith(SKIP):
                    continue
                shutil.copy2(os.path.join(dirpath, name), os.path.join(target_dir, name))
                total += 1
        print("--- 同步 %s -> %s（%d 个文件）" % (rel, root, total))


def sync_provider_sources():
    """供应商适配器是**运行时插件**：服务端从 <数据目录>/providers 读磁盘上的 .ts。
    只重建 server 不会让改过的适配器生效（这一条之前踩过），必须把源码也铺过去。"""
    src = os.path.join(PROJECT, "packages", "providers", "src", "media")
    for root in TARGETS + [PROJECT]:
        dst = os.path.join(root, "data", "providers")
        if not os.path.isdir(os.path.dirname(dst)):
            continue
        os.makedirs(dst, exist_ok=True)
        n = 0
        for name in os.listdir(src):
            if not name.endswith(".ts") or name.endswith(SKIP):
                continue
            shutil.copy2(os.path.join(src, name), os.path.join(dst, name))
            n += 1
        print("--- 同步供应商适配器 -> %s（%d 个文件）" % (dst, n))


def sync_ext():
    """内置「文件扩展」（data/ext 下的 UMD 产物）是**运行时加载**的，改 packages/ext/**
    后必须重建并铺到**两个位置**：`<实例>/build/ext`（内置源，启动时 initializeExt 从
    这里同步）与 `<实例>/data/ext`（实际加载处）。`build_web` 不含它（有独立的 build:ext）。
    ⚠️ 两处内容保持一致：initializeExt 看到 `previous === source` 会直接跳过，不会覆盖。"""
    env = dict(build_env(), NODE_ENV="production")
    proc = subprocess.run([BUN, "run", "--filter", "./packages/ext/*", "build"],
                          cwd=PROJECT, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print((proc.stderr or proc.stdout or "")[-1200:])
        raise SystemExit("!! 文件扩展构建失败")
    src = os.path.join(PROJECT, "build", "ext")
    names = [name for name in os.listdir(src) if name.endswith(".umd.js")]
    for root in TARGETS:
        if not os.path.isdir(root):
            continue
        for rel in (os.path.join("build", "ext"), os.path.join("data", "ext")):
            dst = os.path.join(root, rel)
            os.makedirs(dst, exist_ok=True)
            for name in names:
                shutil.copy2(os.path.join(src, name), os.path.join(dst, name))
        print("--- 同步文件扩展 -> %s（build/ext + data/ext，%d 个文件）" % (root, len(names)))


def sync_tools():
    """把「豆包账号桥」浏览器扩展同步到两个实例。
    客户要从**实例目录**里加载它，服务端 /extension 引导页展示的也是这个路径。"""
    src_ext = os.path.join(PROJECT, "tools", "doubao-cookie-bridge")
    src_crx = os.path.join(PROJECT, "tools", "doubao-cookie-bridge.crx")
    if not os.path.isdir(src_ext):
        print("--- 跳过浏览器扩展同步（tools/doubao-cookie-bridge 不存在）")
        return
    names = os.listdir(src_ext)
    for root in TARGETS:
        if not os.path.isdir(root):
            continue
        dst = os.path.join(root, "tools", "doubao-cookie-bridge")
        os.makedirs(dst, exist_ok=True)
        for name in names:
            shutil.copy2(os.path.join(src_ext, name), os.path.join(dst, name))
        if os.path.isfile(src_crx):
            shutil.copy2(src_crx, os.path.join(root, "tools", "doubao-cookie-bridge.crx"))
        print("--- 同步浏览器扩展 -> %s/tools（%d 个文件）" % (root, len(names)))


def sync_rpa_scripts():
    """RPA（豆包浏览器自动化）跑的是**实例里 scripts/ 下的源码**（bun 直接跑 .ts），
    所以改了 RPA 相关文件必须同步过去，否则实例仍在跑旧代码（这个坑踩过一次：
    「去水印」改了却没生效，就是这里没同步）。只同步白名单，**不要**把整个
    scripts/ 铺过去（里面全是开发脚本与探针）。"""
    src_dir = os.path.join(PROJECT, "scripts")
    for root in TARGETS:
        dst = os.path.join(root, "scripts")
        if not os.path.isdir(os.path.dirname(dst)):
            continue
        os.makedirs(dst, exist_ok=True)
        n = 0
        for name in RPA_SCRIPTS:
            src = os.path.join(src_dir, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(dst, name))
                n += 1
        print("--- 同步 RPA 脚本 -> %s（%d 个文件）" % (dst, n))


def stop_ports(ports=(3000, 18077)):
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stdout
    pids = set()
    for line in out.splitlines():
        if "LISTENING" in line and any(":%d" % p in line for p in ports):
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        print("--- 停止 PID=%s" % pid)
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, text=True)
    subprocess.run(["taskkill", "/IM", "JinyuTV.exe", "/T", "/F"],
                   capture_output=True, text=True)
    time.sleep(1)


def compile_launcher():
    proc = subprocess.run([sys.executable, os.path.join(PROJECT, "scripts", "compile-launcher.py")],
                          cwd=PROJECT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    print(proc.stdout or proc.stderr)
    if proc.returncode != 0:
        raise SystemExit("!! 启动器编译失败")


def sync_web():
    for root in TARGETS:
        if os.path.isdir(os.path.join(root, "build")):
            stash_old_web(root)
    sync_dir("build/web")


def restart_installed():
    starter = os.path.join(INSTALLED, "start-server.bat")
    exe = os.path.join(INSTALLED, "JinyuTV.exe")
    print("--- 启动后端服务（安装版）")
    subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=INSTALLED, close_fds=True,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    time.sleep(3)
    print("--- 打开应用窗口（安装版）")
    subprocess.Popen(["cmd", "/c", "start", "", exe], cwd=INSTALLED, close_fds=True,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def check():
    for _ in range(30):
        time.sleep(2)
        try:
            with NO_PROXY.open("http://127.0.0.1:3000/api/workspaces/list", timeout=8) as resp:
                body = resp.read().decode("utf-8", "replace")
            if resp.status == 200 and "absolutePath" in body:
                print("--- 服务 OK：%s" % body[:160])
                return True
        except Exception:
            pass
    print("!! 服务未就绪")
    return False


if __name__ == "__main__":
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    if only == "server":
        # 只改服务端（含供应商适配器）时走这条：省掉 70 秒的前端构建。
        build_pkg("@toonflow/server")
        sync_dir("build/server")
    else:
        build_web()
        sync_web()
    stop_ports()
    sync_provider_sources()
    sync_rpa_scripts()
    sync_ext()
    sync_tools()
    restart_installed()
    check()
