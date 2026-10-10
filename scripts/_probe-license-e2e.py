# -*- coding: utf-8 -*-
"""主机锁（授权）闭环验证 —— 用真实进程证明四件事。

不满足于「代码写了」，要验证的是**实际行为**：
  ① 未激活 → 服务**真的起不来**（端口不监听、HTTP 000）
  ② 激活后 → 服务正常起来（HTTP 200）
  ③ 授权文件被删 → 立刻失效（回到①）
  ④ 授权文件被复制/篡改 → 拒绝使用
  ⑤ 机器码换成别的机器 → 授权码无效（主机锁的本质）

判活一律用**真发一次 HTTP 看状态码**（项目记忆里的硬要求）：
端口 LISTENING / TCP 连通都只证明「有人 listen」，证明不了服务可用。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../豆包画布开发
SOFTWARE = os.path.join(BASE, "JinyuTV-portable")
BUN = os.path.join(SOFTWARE, "runtime", "bun.exe")
LICENSE = os.path.join(SOFTWARE, "data", "license.json")
BAT = os.path.join(SOFTWARE, "start-server.bat")

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
lines = []


def log(text):
    lines.append(text)
    print(text)


def port_listening(port=3000):
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def http_status(path="/", timeout=6):
    try:
        with opener.open("http://127.0.0.1:3000" + path, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def stop_all():
    """停掉所有 bun / JinyuTV 进程，并确认端口真的空了。

    ⚠️ 必须**确认端口已空**：早先版本 taskkill 之后立刻返回，
    上一个 bun 还在监听 → 后续测到的 HTTP 200 是残留进程的，
    会得出「伪造文件也能启动」这种**完全错误的结论**。
    """
    for image in ("bun.exe", "JinyuTV.exe"):
        subprocess.run(["taskkill", "/IM", image, "/F"], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(40):
        if not port_listening():
            return True
        time.sleep(0.5)
    # 还占着就按 PID 再杀一遍
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stdout
    for line in out.splitlines():
        if ":3000" in line and "LISTENING" in line.upper():
            pid = line.split()[-1]
            if pid.isdigit():
                subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(20):
        if not port_listening():
            return True
        time.sleep(0.5)
    return not port_listening()


def start_server(timeout=40):
    """直接跑 bat（相当于用户绕过启动器双击 bat —— 这条路径必须也被拦住）。"""
    stop_all()
    proc = subprocess.Popen(["cmd", "/c", "start-server.bat"], cwd=SOFTWARE,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_listening():
            return proc
        if proc.poll() is not None:
            return proc            # 已退出 = 被拦住了
        time.sleep(0.6)
    return proc


def read_log_tail(marker, lines_n=6):
    path = os.path.join(SOFTWARE, "logs", "server.log")
    try:
        with open(path, "rb") as fh:
            text = fh.read().decode("utf-8", "replace").replace("\x00", "")
    except Exception:
        return ""
    hits = [l for l in text.splitlines() if marker in l]
    return "\n     ".join(hits[-lines_n:])


def license_state():
    if not os.path.isfile(LICENSE):
        return "不存在"
    try:
        data = json.load(open(LICENSE, encoding="utf-8"))
    except Exception as e:
        return "损坏(%s)" % e
    return "存在（机器码 %s）" % data.get("machineCode")


print("=" * 70)
print(" 主机锁闭环验证 —— 判据是「真发 HTTP 看状态码」")
print("=" * 70)

#备份原有授权（如果有），最后恢复
backup = None
if os.path.isfile(LICENSE):
    backup = open(LICENSE, "rb").read()

results = {}
try:
    # ---------------------------------------------------------- ① 未激活
    if os.path.isfile(LICENSE):
        os.remove(LICENSE)
    log("\n① 未激活（无授权文件）→ 服务应起不来")
    log("   授权文件：%s" % license_state())
    proc = start_server()
    time.sleep(2)
    status = http_status()
    log("   进程已退出：%s" % ("是" if proc.poll() is not None else "否"))
    log("   端口 3000：%s" % ("监听中" if port_listening() else "未监听"))
    log("   HTTP 状态：%s" % status)
    log("   服务端日志：\n     " + read_log_tail("授权"))
    results["未激活被拦"] = (not port_listening()) and status == 0

    # ---------------------------------------------------------- ② 激活后
    log("\n② 激活后 → 服务应正常起来")
    log("   用授权码激活（逻辑与用户在窗口里粘贴完全相同）…")
    spec = os.path.join(BASE, "toonflow", "scripts", "license", "make-license.py")
    import importlib.util
    module = importlib.util.spec_from_file_location("ml", spec)
    ml = importlib.util.module_from_spec(module)
    module.loader.exec_module(ml)
    machine = json.loads(subprocess.run(
        [BUN, "run", "scripts/license/license-bridge.ts"],
        input=json.dumps({"action": "machineCode"}), cwd=SOFTWARE,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stdout.strip().splitlines()[-1])["machineCode"]
    code = ml.sign(machine, "闭环验证")
    r = subprocess.run([BUN, "run", "scripts/license/license-bridge.ts"],
                       input=json.dumps({"action": "activate", "code": code, "licenseFile": LICENSE}),
                       cwd=SOFTWARE, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    log("   激活结果：%s" % r.stdout.strip()[:110])
    log("   授权文件：%s" % license_state())

    start_server()
    time.sleep(2)
    status = http_status()
    log("   端口 3000：%s" % ("监听中" if port_listening() else "未监听"))
    log("   HTTP 状态：%s" % status)
    log("   服务端日志：\n     " + read_log_tail("授权"))
    results["激活后可��"] = port_listening() and status == 200

    # ---------------------------------------------------------- ③ 删掉授权
    log("\n③ 删掉授权文件 → 应立刻失效")
    os.remove(LICENSE)
    log("   授权文件：%s" % license_state())
    start_server()
    time.sleep(2)
    status = http_status()
    log("   端口 3000：%s" % ("监听中" if port_listening() else "未监听"))
    log("   HTTP 状态：%s" % status)
    results["删除后失效"] = (not port_listening()) and status == 0

    # ---------------------------------------------------------- ④ 篡改授权
    log("\n④ 篡改授权码（模拟用户改文件绕过）→ 应拒绝")
    data = {"code": code[:-4] + "ZZZZ", "machineCode": machine,
            "issuedAt": "2026-01-01", "activatedAt": "2026-01-01T00:00:00.000Z"}
    with open(LICENSE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    start_server()
    time.sleep(2)
    status = http_status()
    log("   HTTP 状态：%s（应非 200）" % status)
    log("   服务端日志：\n     " + read_log_tail("授权"))
    results["篡改被拒"] = status != 200

    # ---------------------------------------------------------- ⑤ 换机器码
    log("\n⑤ 换一台电脑用同一个码 → 必须拒绝（主机锁的本质）")
    # 说明：这里**不改授权文件的任何字段**。
    # 改字段会先让签名失效（报「签名无效」），那验证的是防伪造、不是主机锁。
    # 主机锁要验的是「另一台机器拿着这个码去激活」——只能靠让验签在别的机器码上进行。
    helper = os.path.join(SOFTWARE, "scripts", "_tmp-verify-other.ts")
    with open(helper, "w", encoding="utf-8") as fh:
        fh.write(
            'import { verifyLicense } from "./license/license-core";\n'
            'import { readFileSync } from "node:fs";\n'
            'const code = readFileSync(process.argv[2], "utf8").trim();\n'
            'const res = await verifyLicense(code, "AAAAA-BBBBB-CCCCC-DDDDD");\n'
            'console.log(JSON.stringify(res));\n'
        )
    code_file = os.path.join(SOFTWARE, "data", "_license-code-for-test.txt")
    with open(code_file, "w", encoding="utf-8") as fh:
        fh.write(code)
    r = subprocess.run([BUN, "run", "scripts/_tmp-verify-other.ts", code_file],
                       cwd=SOFTWARE, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    try:
        other = json.loads((r.stdout or "").strip().splitlines()[-1])
    except Exception:
        other = {"ok": None, "reason": (r.stderr or r.stdout or "")[:150]}
    log("   另一台机器验同一个码 → %s" % json.dumps(other, ensure_ascii=False)[:170])

    # 反面对照：同一个码在本机上必须能通过（证明上一条不是因为码本身坏了）
    with open(LICENSE, "w", encoding="utf-8") as fh:
        json.dump({"code": code, "machineCode": machine,
                   "issuedAt": "2026-01-01", "activatedAt": "2026-01-01T00:00:00.000Z"}, fh, indent=2)
    start_server()
    time.sleep(2)
    status_ok = http_status()
    log("   对照：本机用同一个码 → HTTP %s（应为 200）" % status_ok)

    results["换机被拒"] = (other.get("ok") is False) and status_ok == 200
    os.remove(helper)
    os.remove(code_file)

finally:
    # 恢复现场：把本机授权放回去，让软件能正常用
    stop_all()
    other_file = os.path.join(SOFTWARE, "_out", "other-machine.json")
    if os.path.isfile(other_file):
        os.remove(other_file)
    if backup:
        with open(LICENSE, "wb") as fh:
            fh.write(backup)
        log("\n已恢复原有授权文件")
    else:
        log("\n（无原有授权文件，保持未激活状态以便你手动体验激活流程）")

log("\n" + "=" * 70)
log(" 验证结果")
log("=" * 70)
for name, ok in results.items():
    log("  %-12s %s" % (name, "✓ 通过" if ok else "✗ 失败"))
log("")
log("全部通过：%s" % all(results.values()))

out = os.path.join(BASE, "toonflow", "scripts", "_out", "license-e2e.log")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")