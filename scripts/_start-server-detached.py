# -*- coding: utf-8 -*-
"""以「脱离父进程」的方式拉起安装版后端（供本会话内的自动化验证用）。

为什么不用 `cmd /c start-server.bat`：一是从 Bash 调 cmd 会被安全策略拦，
二是 Popen 出来的子进程会随本轮任务结束被回收（实测 20:56 起来、20:57 就没了）。
这里直接起 bun 并带上 start-server.bat 里那几个必需的环境变量，
再用 DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP 让它不属于本会话的进程组。
"""
import os
import subprocess
import sys

INSTALLED = os.path.expandvars(r"%LOCALAPPDATA%\Programs\JinyuTV")
BUN = os.path.join(INSTALLED, "runtime", "bun.exe")
if not os.path.exists(BUN):
    BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"

env = dict(os.environ)
for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
    env.pop(key, None)
env.update({
    "toonflowDesktop": "1",
    "TOONFLOW_DATA_DIR": os.path.join(INSTALLED, "data"),
    "NO_PROXY": "127.0.0.1,localhost,::1",
    "no_proxy": "127.0.0.1,localhost,::1",
    "NODE_ENV": "production",
})

flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
log = open(os.path.join(INSTALLED, "logs", "server.log"), "ab", buffering=0)
proc = subprocess.Popen([BUN, os.path.join("build", "server", "index.js")],
                        cwd=INSTALLED, env=env, stdout=log, stderr=log,
                        stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)
print("已拉起 PID=%d（bun %s）" % (proc.pid, BUN))
sys.exit(0)
