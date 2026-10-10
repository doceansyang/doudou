# -*- coding: utf-8 -*-
"""从指定安装目录启动服务并自检 —— 用来验证「换台电脑/换个目录」后软件能否起来。

用法：
  python scripts/test-installed.py [安装目录]
默认目录为 %LOCALAPPDATA%\\Programs\\JinyuTV。
"""
import os
import subprocess
import sys
import time
import urllib.request

DEFAULT_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "JinyuTV")

# 本机有 HTTP 代理，探测 127.0.0.1 必须绕过，否则代理会返回 502 干扰判断。
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def probe(url, timeout=8):
    try:
        with NO_PROXY.open(url, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except Exception as error:  # noqa: BLE001
        return None, str(error)


def stop_ports(ports=(3000, 18077)):
    """停掉占用端口的进程，保证测试从干净状态开始。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace").stdout
    except OSError:
        return
    pids = set()
    for line in out.splitlines():
        if "LISTENING" in line and any(":%d" % p in line for p in ports):
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        print("  停止 PID=%s" % pid)
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, text=True)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    if not os.path.isdir(target):
        raise SystemExit("目录不存在：%s" % target)

    print("=== 测试目标：%s" % target)
    print("--- 清理端口")
    stop_ports()
    time.sleep(2)

    bat = os.path.join(target, "start-server.bat")
    log = os.path.join(target, "logs", "server.log")
    if os.path.exists(log):
        os.remove(log)  # 只看本次启动的输出

    print("--- 启动（python -> cmd -> start-server.bat，与启动器等价的机制）")
    subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=target, close_fds=True,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    print("--- 等待服务就绪（最多 60 秒）")
    status = None
    for i in range(30):
        time.sleep(2)
        status, _ = probe("http://127.0.0.1:3000/")
        if status == 200:
            print("  %d 秒后 3000 就绪" % ((i + 1) * 2))
            break
    else:
        print("  !! 超时，3000 未就绪")

    print("\n--- 自检结果")
    main_status, html = probe("http://127.0.0.1:3000/")
    print("  主服务 3000 : %s" % (main_status if main_status else "无响应"))
    title = ""
    if "<title>" in (html or ""):
        title = html.split("<title>")[1].split("</title>")[0]
    print("  页面标题    : %s" % title)
    rpa_status, rpa_body = probe("http://127.0.0.1:18077/health")
    print("  RPA   18077 : %s %s" % (rpa_status if rpa_status else "无响应", (rpa_body or "")[:80]))

    print("\n--- 日志尾部（%s）" % log)
    try:
        with open(log, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        for line in lines[-14:]:
            print("  " + line[:170])
    except OSError as error:
        print("  读取日志失败：%s" % error)

    return 0 if main_status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
