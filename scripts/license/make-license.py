# -*- coding: utf-8 -*-
"""JinyuTV 授权码生成器（离线，你自己用）。

用法（三种，任选）：
    ① 双击本文件所在目录的「签发授权码.bat」
    ② 命令行： python scripts/license/make-license.py <机器码> [备注]
       例：       python scripts/license/make-license.py 81DE1-D8EC7-15AE3-FAEDA 张三
    ③ 不给参数时进入交互模式，提示输入机器码

客户拿到授权码后，在软件启动窗口的输入框里粘贴 → 点「激活」即可。

⚠️ 安全须知
  · 私钥在 C:\\Users\\<你的用户名>\\.workbuddy\\tools\\jinyutv-license\\private.jwk
    **绝不能**提交到 git、**绝不能**打进安装包、**绝不能**发给客户。
  · 私钥一旦丢失：已发出的授权码仍然有效，但**无法再签发新码**。
    换密钥对的话，旧授权码会全部失效，已激活的客户需要重新授权。
  · 授权码是永久授权、一台电脑绑定；换电脑需重新签发。

它做了什么：把「机器码 + 签发信息」用 Ed25519 私钥签名，
软件里只存公钥（只能验、不能签），所以别人**无法自行生成合法授权码**。
签名算法与软件内的公钥来自同一处（scripts/license/license-core.ts）。
"""
import json
import os
import subprocess
import sys

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # .../toonflow/scripts
PROJECT = os.path.dirname(SCRIPTS)                                            # .../toonflow
BUN = os.environ.get("BUN") or os.path.expanduser(
    "~/.workbuddy/tools/bun/bun.exe"
)
PRIVATE_JWK = os.path.join(
    os.environ.get("USERPROFILE", os.path.expanduser("~")),
    ".workbuddy", "tools", "jinyutv-license", "private.jwk",
)

# 真正的签发逻辑放在 TS 里（与软件运行时共用同一套实现，避免两边算法漂移）
SIGN_SCRIPT = os.path.join(SCRIPTS, "license", "sign.ts")


def normalize_machine_code(raw: str) -> str:
    """规整用户输入的机器码。

    用户往往会在意格式（少打一个、多个空格、从聊天软件复制带引号）。
    这里只保留 0-9A-F 并按 5 位一组，容错到"少一位也给签"，
    真正的匹配由软件侧严格比较决定 —— 签错会在激活时立刻被拒绝，不会静默通过。
    """
    hex_only = "".join(ch for ch in raw.upper() if ch in "0123456789ABCDEF")
    groups = [hex_only[i:i + 5] for i in range(0, len(hex_only), 5)]
    return "-".join(groups)


def sign(machine_code: str, note: str = "") -> str:
    if not os.path.isfile(PRIVATE_JWK):
        raise SystemExit(
            "!! 找不到私钥：%s\n"
            "   私钥不在这里就无法签发。请确认这是你的机器，"
            "且私钥文件没有被删除。" % PRIVATE_JWK
        )
    if not os.path.isfile(BUN):
        raise SystemExit("!! 找不到 bun：%s" % BUN)
    payload = json.dumps({
        "machineCode": machine_code,
        "note": note,
    }, ensure_ascii=False)
    result = subprocess.run(
        [BUN, SIGN_SCRIPT, PRIVATE_JWK],
        input=payload, capture_output=True, text=True,
        encoding="utf-8", errors="replace", cwd=PROJECT,
    )
    if result.returncode != 0:
        raise SystemExit("!! 签发失败：%s" % (result.stderr or result.stdout).strip())
    out = (result.stdout or "").strip()
    if not out or out.startswith("!!"):
        raise SystemExit("!! 签发失败：%s" % out)
    return out


def main() -> int:
    print("=" * 62)
    print(" JinyuTV 授权码生成器   —— 永久授权 / 一台电脑绑定")
    print("=" * 62)

    machine = sys.argv[1] if len(sys.argv) > 1 else ""
    note = sys.argv[2] if len(sys.argv) > 2 else ""

    if not machine:
        print("\n请把客户软件启动窗口里的「机器码」粘贴到下面：")
        print("（形如 81DE1-D8EC7-15AE3-FAEDA）\n")
        try:
            machine = input("机器码> ").strip().strip('"').strip("'")
        except (EOFError, KeyboardInterrupt):
            print("\n已取消。")
            return 1

    normalized = normalize_machine_code(machine)
    if not normalized:
        raise SystemExit("!! 机器码看起来不含有效字符，请让客户重新提供。")
    if len(normalized.replace("-", "")) != 20:
        print("提示：机器码长度为 %d 位（标准 20 位）。仍继续签发，"
              "但若客户机器码输入有误，激活时会提示不匹配。"
              % len(normalized.replace("-", "")))

    if not note:
        try:
            note = input("备注（客户名/订单号，可留空）> ").strip()
        except (EOFError, KeyboardInterrupt):
            note = ""

    code = sign(normalized, note)

    print("\n" + "-" * 62)
    print(" 机器码：%s" % normalized)
    if note:
        print(" 备注　：%s" % note)
    print("-" * 62)
    print("\n授权码（发给客户，让他在软件启动窗口粘贴）：\n")
    # 分块显示，便于口头核对或在聊天软件里分段发送
    for i in range(0, len(code), 60):
        print("  " + code[i:i + 60])
    print("\n" + "-" * 62)
    print("长度 %d 字符。激活后永久有效，且只能在这台电脑上使用。" % len(code))
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())