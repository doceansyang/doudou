# -*- coding: utf-8 -*-
"""诊断：启动器里那条 `cmd /c ...start-server.bat` 的引号写法，哪种真的能跑。

背景：launcher.cs 用 `/c ""<bat>""` 时，安装版日志里连 "server start" 都没写入，
说明命令根本没执行。这里把几种写法逐个跑一遍，看服务是否起来。
"""
import os
import subprocess
import sys
import time

INST = r"C:\Users\JinYuDream\AppData\Local\Programs\JinyuTV"
BAT = os.path.join(INST, "start-server.bat")
LOG = os.path.join(INST, "logs", "server.log")


def kill_ports():
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stdout
    pids = {l.split()[-1] for l in out.splitlines()
            if "LISTENING" in l and (":3000" in l or ":18077" in l) and l.split()[-1].isdigit()}
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, text=True)
    if pids:
        time.sleep(2)


def log_size():
    try:
        return os.path.getsize(LOG)
    except OSError:
        return -1


def try_variant(label, args):
    kill_ports()
    before = log_size()
    print("\n--- %s" % label)
    print("    argv: %r" % (args,))
    subprocess.Popen(args, cwd=INST, close_fds=True)
    for _ in range(12):
        time.sleep(1)
        if log_size() != before:
            print("    ✓ 日志有新内容，命令执行成功")
            return True
    print("    ✗ 日志无变化，命令未执行")
    return False


def main():
    variants = [
        ("A 启动器当前写法 /c \"\"bat\"\"", ["cmd", "/c", '""' + BAT + '""']),
        ("B /c \"bat\"", ["cmd", "/c", '"' + BAT + '"']),
        ("C /c bat（无引号）", ["cmd", "/c", BAT]),
    ]
    results = {}
    for label, args in variants:
        results[label] = try_variant(label, args)
    print("\n===== 结论 =====")
    for label, ok in results.items():
        print("  %s : %s" % ("可用" if ok else "不可用", label))
    return 0


if __name__ == "__main__":
    sys.exit(main())
