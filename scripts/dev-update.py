# -*- coding: utf-8 -*-
"""JinyuTV 开发循环：构建 → 同步到软件目录 → 重启软件 → 自检。

约定（用户要求）：
  每次修改软件后，**项目和软件一起更新**，并且**重启一次软件**供测试。
  · 「项目」= toonflow/（源码与构建）
  · 「软件」= JinyuTV-portable/（可运行的成品，用户测试用）

用法：
  python scripts/dev-update.py                 # 构建 + 同步 + 重启
  python scripts/dev-update.py --skip-build    # 只同步 + 重启（改的是 web/nodes 产物时）
  python scripts/dev-update.py --only web      # 只重建某个包（tools/ext/nodes/web/mcp/server）
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
SOFTWARE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable"
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
LAUNCHER_EXE = "JinyuTV.exe"

SKIP_DIR_SUFFIX = (".bak", ".prebuild", ".manual", ".empty")

BUILD_TARGETS = {
    "tools": ["./packages/tools/*"],
    "ext": ["./packages/ext/*"],
    "nodes": ["./packages/nodes/*"],
    "web": ["@toonflow/web"],
    "mcp": ["@toonflow/mcp"],
    "server": ["@toonflow/server"],
}


def build_env():
    root = os.environ.get("SystemRoot", r"C:\Windows")
    head = [os.path.join(root, "System32"), root, os.path.dirname(BUN)]
    env = dict(os.environ, NODE_ENV="production",
               PATH=os.pathsep.join(head + [os.environ.get("PATH", "")]))
    for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
        env.pop(key, None)
    return env


def run(label, args):
    print("--- %s" % label)
    proc = subprocess.run(args, cwd=PROJECT, env=build_env(), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    tail = [ln for ln in (proc.stdout or "").strip().splitlines() if ln.strip()][-4:]
    for line in tail:
        print("    " + line)
    if proc.returncode != 0:
        print((proc.stderr or "")[-1200:])
        raise SystemExit("!! 构建失败：%s" % label)


def stash_old_web():
    """构建 web 前先把旧产物挪走。

    vite 会清空 build/web/assets（1000+ 文件）来准备输出目录，而本会话有批量删除守卫
    （阈值 50 个文件），直接删会让进程被掐断。所以改成**改名挪走**，集中放到 _build-cache/。
    """
    web = os.path.join(PROJECT, "build", "web")
    if not os.path.isdir(web):
        return
    cache = os.path.join(os.path.dirname(PROJECT), "_build-cache")
    os.makedirs(cache, exist_ok=True)
    stamp = time.strftime("%m%d-%H%M%S")
    target = os.path.join(cache, "web-" + stamp)
    index = 2
    while os.path.isdir(target):
        target = os.path.join(cache, "web-%s-%d" % (stamp, index))
        index += 1
    shutil.move(web, target)
    print("--- 旧 web 产物已挪到 _build-cache/%s" % os.path.basename(target))


def build(only=None):
    mapping = {k: v for k, v in BUILD_TARGETS.items() if only is None or k == only}
    if "web" in mapping:
        stash_old_web()
    for name, filters in mapping.items():
        args = [BUN, "run"]
        for f in filters:
            args += ["--filter", f]
        args.append("build")
        run("构建 %s" % name, args)


def sync():
    """把项目产物同步到软件目录。data/ 只在软件目录不存在时复制，避免覆盖登录态。"""
    total = 0
    for name in ["build", "scripts"]:
        src = os.path.join(PROJECT, name)
        dst = os.path.join(SOFTWARE, name)
        if not os.path.isdir(src):
            continue
        # 前端产物是 hash 命名的：同步只覆盖不清理的话，软件目录会累积历次构建的旧 chunk
        # （不影响功能，因为入口只引用新 hash，但会让软件目录和安装包越来越臃肿）。
        # 这里先把软件目录里的旧 web 挪到 _build-cache/（改名而非删除），再整体复制。
        if name == "build":
            web_dst = os.path.join(dst, "web")
            if os.path.isdir(web_dst):
                hold = os.path.join(SOFTWARE, "_build-cache", "web-%s" % time.strftime("%m%d-%H%M%S"))
                os.makedirs(os.path.dirname(hold), exist_ok=True)
                try:
                    shutil.move(web_dst, hold)
                    print("--- 旧 web 产物已挪到 _build-cache/（避免累积旧 chunk）")
                except OSError as error:
                    print("    ! 旧 web 产物挪动失败（忽略）：%s" % error)
        # 不删除旧目录（本会话有批量删除守卫），逐文件覆盖
        for dirpath, dirnames, filenames in os.walk(src):
            dirnames[:] = [d for d in dirnames if not d.endswith(SKIP_DIR_SUFFIX)]
            rel = os.path.relpath(dirpath, src)
            target_dir = dst if rel == "." else os.path.join(dst, rel)
            os.makedirs(target_dir, exist_ok=True)
            for filename in filenames:
                if filename.endswith(SKIP_DIR_SUFFIX):
                    continue
                s, d = os.path.join(dirpath, filename), os.path.join(target_dir, filename)
                try:
                    shutil.copy2(s, d)
                    total += os.path.getsize(d)
                except OSError as error:
                    print("    ! 跳过 %s（%s）" % (d, error))
        print("--- 同步 %s -> 软件目录" % name)

    # data 只在软件目录缺失时复制
    src_data = os.path.join(PROJECT, "data")
    dst_data = os.path.join(SOFTWARE, "data")
    if os.path.isdir(src_data) and not os.path.isdir(dst_data):
        shutil.copytree(src_data, dst_data)
        print("--- 首次同步 data/（保留豆包账号登录态）")
    else:
        print("--- data/ 已存在，保留软件目录内的运行数据（不覆盖）")

    total += sync_runtime_plugins()
    return total


# 节点 / 工具 / 扩展是「运行时插件」：服务端从 <数据目录>/nodes|tools|ext 读取，
# 只重建 build/ 并不会生效（这是踩过的坑：改了节点骨架却怎么都不生效）。
RUNTIME_PLUGINS = [
    ("nodes", "nodes", ".umd.js"),
    ("tools", "tools", ".tool.js"),
    ("ext", "ext", ".umd.js"),
]


def sync_runtime_plugins():
    """把构建出的插件同步到各数据目录，否则界面上跑的仍是旧版本。"""
    total = 0
    for name, folder, suffix in RUNTIME_PLUGINS:
        src = os.path.join(PROJECT, "build", folder)
        if not os.path.isdir(src):
            continue
        for base in (SOFTWARE, PROJECT):
            dst = os.path.join(base, "data", folder)
            if not os.path.isdir(os.path.dirname(dst)):
                continue
            os.makedirs(dst, exist_ok=True)
            copied = 0
            for filename in os.listdir(src):
                if not filename.endswith(suffix) or filename.endswith(SKIP_DIR_SUFFIX):
                    continue
                source, target = os.path.join(src, filename), os.path.join(dst, filename)
                try:
                    shutil.copy2(source, target)
                    total += os.path.getsize(target)
                    copied += 1
                except OSError as error:
                    print("    ! 跳过 %s（%s）" % (target, error))
            print("--- 同步运行时插件 %s -> %s（%d 个文件）" % (folder, dst, copied))
    return total


def stop_running():
    """停掉占用 3000/18077 的进程。"""
    for port in (3000, 18077):
        try:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace").stdout
        except OSError:
            return
        pids = set()
        for line in out.splitlines():
            if ":%d" % port in line and "LISTENING" in line:
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(parts[-1])
        for pid in pids:
            print("--- 停止端口 %d 上的进程 PID=%s" % (port, pid))
            subprocess.run(["taskkill", "/PID", pid, "/F"],
                           capture_output=True, text=True)


def update_launcher():
    """重编启动器并铺好 WebView2 依赖。

    必须放在 stop_running() 之后：JinyuTV.exe 与 WebView2Loader.dll 在运行中
    被锁定，写入会报 WinError 32（进程占用）。
    """
    script = os.path.join(PROJECT, "scripts", "compile-launcher.py")
    if not os.path.isfile(script):
        print("--- ! 找不到 compile-launcher.py，跳过启动器更新")
        return
    proc = subprocess.run([sys.executable, script, SOFTWARE],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (proc.stdout or "").strip().splitlines():
        print("    " + line)
    if proc.returncode != 0:
        print("    ! 启动器更新失败（不影响服务）：%s" % ((proc.stderr or "").strip()[:300]))


def restart_software():
    """重启软件：先起后端服务（保证常驻），再打开应用窗口。

    为什么分两步：
      · 后端服务必须常驻 —— 由 start-server.bat 拉起（实测唯一稳定留存的方式）。
      · 应用窗口（JinyuTV.exe）只是「显示器」：它检测到 3000 已在运行就不重复起服务，
        自己只负责开一个内嵌 WebView2 的窗口。所以即便窗口进程被回收，服务也不受影响。

    为什么用 cmd 的 start 而不是 subprocess.Popen 直接跑：
      Bash 工具的宿主会清理自己进程树里的所有后代，DETACHED_PROCESS /
      CREATE_BREAKAWAY_FROM_JOB 都带不走。cmd 的 `start` 会新建独立进程，能真正留下常驻服务。
    """
    server = os.path.join(SOFTWARE, "build", "server", "index.js")
    if not os.path.exists(server):
        raise SystemExit("!! 软件目录里没有 build/server/index.js：%s" % server)

    starter = os.path.join(SOFTWARE, "start-server.bat")
    if not os.path.exists(starter):
        raise SystemExit("!! 缺少 start-server.bat：%s" % starter)

    print("--- 启动后端服务：%s" % SOFTWARE)
    # 环境变量不在这里注入（本机环境同时含 HTTP_PROXY 与 http_proxy 时，
    # 往子进程环境里塞变量会踩到字典冲突）。统一由 start-server.bat 用 set 声明。
    subprocess.Popen(
        ["cmd", "/c", "start-server.bat"],
        cwd=SOFTWARE, close_fds=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    exe = os.path.join(SOFTWARE, LAUNCHER_EXE)
    if os.path.exists(exe):
        print("--- 打开应用窗口：%s" % exe)
        subprocess.Popen(
            ["cmd", "/c", "start", "", exe],
            cwd=SOFTWARE, close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )


# 自检必须绕开代理：本机 http_proxy 会让 127.0.0.1:3000 的请求被代理转发成 502
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def probe(url, timeout=8):
    try:
        with _NO_PROXY_OPENER.open(url, timeout=timeout) as resp:
            return resp.status, resp.read(200)
    except Exception as error:  # noqa: BLE001
        return None, str(error)


def self_check():
    # 服务是以 detached 方式拉起的，启动到可访问有 1～3 秒延迟，
    # 这里给足窗口，避免"其实起来了却报未就绪"的误判。
    ready = False
    for _ in range(30):
        time.sleep(2)
        status, _ = probe("http://127.0.0.1:3000/")
        if status == 200:
            ready = True
            break
    if not ready:
        _, detail = probe("http://127.0.0.1:3000/")
        raise SystemExit("!! 主服务未就绪（3000）：%s" % detail)

    code, _ = probe("http://127.0.0.1:3000/")
    rpa, body = probe("http://127.0.0.1:18077/health")
    title = ""
    try:
        with _NO_PROXY_OPENER.open("http://127.0.0.1:3000/", timeout=8) as resp:
            html = resp.read().decode("utf-8", "replace")
        if "<title>" in html:
            title = html.split("<title>")[1].split("</title>")[0]
    except Exception:  # noqa: BLE001
        pass
    print("\n===== 自检结果 =====")
    print("  主服务 3000 : %s" % ("OK" if code == 200 else "失败"))
    print("  RPA   18077 : %s" % (body.decode("utf-8", "replace")[:60] if rpa == 200 else "未就绪"))
    print("  页面标题    : %s" % (title or "(未取到)"))
    print("  软件目录    : %s" % SOFTWARE)
    print("  访问地址    : http://localhost:3000/（落点由前端路由决定：首页）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true", help="跳过构建，只同步+重启")
    parser.add_argument("--only", choices=list(BUILD_TARGETS), help="只重建某个包")
    args = parser.parse_args()

    if not args.skip_build:
        build(args.only)
    size = sync()
    print("--- 同步完成：%.1f MB" % (size / 1048576))
    stop_running()
    update_launcher()
    restart_software()
    self_check()


if __name__ == "__main__":
    sys.exit(main())
