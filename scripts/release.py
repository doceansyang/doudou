# -*- coding: utf-8 -*-
"""发版：升版本 → 构建安装包 → 生成更新清单 → 建 GitHub Release → 上传自有托管 → 推送源码。

一条命令（在项目里执行）：
    python toonflow/scripts/release.py                  # 用 package.json 里的当前版本发布
    python toonflow/scripts/release.py --bump patch      # 先把版本升一位再发布
    python toonflow/scripts/release.py --notes "修复：…"  # 自定义更新说明
    python toonflow/scripts/release.py --dry-run         # 只看会做什么，不写盘、不联网

约定（客户端的「检查更新」依赖这些，改之前先看 services 是怎么读的）：
  · **版本号唯一来源**：仓库根 `package.json` 的 `version`。本脚本只改这一处。
  · **GitHub Release 标签**：`vX.Y.Z`（存档用）
  · **资产**：`JinyuTV-X.Y.Z-Setup.exe` + `latest.json`
  · **客户端真正的更新源**是自有托管 `https://linke.link/jinyutv-update/`
    （nginx 静态吐文件，见 _deploy-update-host.py）—— GitHub 直连在国内超时
    （软件进程的 bun fetch 不走系统代理），所以发版后必须把两个资产 sftp 上传过去。
    `downloadUrl` 也写成自有托管直链，「一键下载安装包」同样不走 GitHub。
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(SCRIPTS)
BASE = os.path.dirname(PROJECT)
PKG = os.path.join(PROJECT, "package.json")

REPO = "doceansyang/doudou"
TAG_PREFIX = "v"
CHANNEL = "stable"
# 客户端真正的更新源（nginx 静态托管，见 _deploy-update-host.py）：
# latest.json 与安装包都发两份 —— GitHub 作存档，这里作「检查更新 / 一键下载」的实际来源。
UPDATE_HOST_BASE = "https://linke.link/jinyutv-update"
UPDATE_HOST_DIR = "/var/www/jinyutv-update"

GH = os.environ.get("GH_CLI") or (
    r"C:/Users/JinYuDream/.workbuddy/tools/gh/gh.exe"
    if os.path.isfile(r"C:/Users/JinYuDream/.workbuddy/tools/gh/gh.exe") else "gh"
)


def run(args, cwd=PROJECT, capture=False, check=True):
    printable = " ".join(args)
    print("  $ %s" % printable)
    result = subprocess.run(args, cwd=cwd, capture_output=capture, text=True,
                            encoding="utf-8", errors="replace")
    if capture and result.stdout:
        return result.stdout.strip()
    if check and result.returncode != 0:
        raise SystemExit("!! 命令失败（%s）：%s" % (result.returncode, printable))
    return ""


def read_pkg():
    with open(PKG, encoding="utf-8") as handle:
        return json.load(handle)


def write_pkg(pkg):
    with open(PKG, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(pkg, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def bump(version, kind):
    parts = [int(part) for part in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    if kind == "major":
        parts = [parts[0] + 1, 0, 0]
    elif kind == "minor":
        parts = [parts[0], parts[1] + 1, 0]
    else:
        parts = [parts[0], parts[1], parts[2] + 1]
    return ".".join(str(part) for part in parts)


def git(*args):
    return run(["git"] + list(args), capture=True, check=False)


def last_tag():
    tags = git("tag", "--list", TAG_PREFIX + "[0-9]*", "--sort=-v:refname").splitlines()
    return tags[0].strip() if tags else ""


def default_notes(previous_tag):
    """更新说明：优先取上次发布以来的提交标题。"""
    rev = "%s..HEAD" % previous_tag if previous_tag else "-n 12"
    args = ["log", "--pretty=format:- %s", rev] if previous_tag else ["log", "--pretty=format:- %s", "-n", "12"]
    text = git(*args)
    return text.strip() or "维护性更新。"


def main():
    parser = argparse.ArgumentParser(description="发布新版本到 GitHub Releases")
    parser.add_argument("--bump", choices=["patch", "minor", "major"], help="先把版本号升一位")
    parser.add_argument("--version", help="直接指定版本号（形如 2.0.1）")
    parser.add_argument("--notes", help="更新说明（默认取上次发布以来的提交标题）")
    parser.add_argument("--notes-file", help="从文件读更新说明")
    parser.add_argument("--skip-build", action="store_true", help="跳过构建（复用已有安装包）")
    parser.add_argument("--no-push", action="store_true", help="不推送源码，只建 Release")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要做什么")
    args = parser.parse_args()

    pkg = read_pkg()
    version = (args.version or pkg.get("version") or "").strip()
    if args.bump:
        version = bump(version, args.bump)
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        raise SystemExit("版本号不合法：%r（应形如 2.0.1）" % version)

    tag = TAG_PREFIX + version
    setup = os.path.join(BASE, "JinyuTV-%s-Setup.exe" % version)
    manifest = os.path.join(BASE, "latest.json")
    # downloadUrl 写自有托管：客户端「一键下载安装包」不能指 GitHub（国内超时）。
    download_url = "%s/JinyuTV-%s-Setup.exe" % (UPDATE_HOST_BASE, version)

    notes = args.notes or ""
    if args.notes_file:
        with open(args.notes_file, encoding="utf-8") as handle:
            notes = handle.read().strip()
    if not notes:
        notes = default_notes(last_tag())

    print("===== 发布计划 =====")
    print("  仓库      : %s" % REPO)
    print("  版本      : %s  (package.json 当前 %s)" % (version, pkg.get("version")))
    print("  标签      : %s" % tag)
    print("  安装包    : %s" % setup)
    print("  清单      : %s" % manifest)
    print("  下载直链  : %s" % download_url)
    print("  更新说明  :")
    for line in notes.splitlines():
        print("      " + line)
    print()

    if args.dry_run:
        print("（--dry-run：不做任何修改）")
        return 0

    # 1) 版本号写回 package.json（唯一来源；构建脚本与安装包都从这里取）
    if pkg.get("version") != version:
        pkg["version"] = version
        write_pkg(pkg)
        print("--- 已把 package.json 版本改为 %s" % version)

    # 2) 构建安装包（内部会同步 package.json 到绿色版，并把它打进发行包 ——
    #    服务端靠安装目录里的这份 package.json 知道自己是哪个版本）
    if args.skip_build:
        if not os.path.isfile(setup):
            raise SystemExit("找不到安装包（--skip-build 需要它已存在）：%s" % setup)
        print("--- 跳过构建，复用 %s" % setup)
    else:
        print("--- 构建安装包")
        run([sys.executable, os.path.join(SCRIPTS, "build-installer.py")])

    # 3) 生成更新清单
    payload = {
        "version": version,
        "channel": CHANNEL,
        "hash": git("rev-parse", "--short", "HEAD") or version,
        "releasedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "notes": notes,
        "downloadUrl": download_url,
        "assetName": os.path.basename(setup),
    }
    with open(manifest, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("--- 已生成 %s" % manifest)

    # 4) 推送源码（先推代码，标签指向的提交才在远端存在）
    if not args.no_push:
        print("--- 提交并推送源码")
        run(["git", "add", "-A"])
        run(["git", "commit", "-m", "发布 %s" % tag], check=False)
        run(["git", "push", "origin", "HEAD:main"], check=False)
    else:
        print("--- 已跳过源码推送（--no-push）")

    # 5) 建 Release 并上传资产（存档；客户端实际走自有托管）
    print("--- 创建 GitHub Release %s" % tag)
    exists = run([GH, "release", "view", tag, "--repo", REPO], capture=True, check=False)
    if exists:
        print("    %s 已存在，改为上传/覆盖资产" % tag)
        run([GH, "release", "upload", tag, setup, manifest, "--repo", REPO, "--clobber"])
    else:
        run([GH, "release", "create", tag, setup, manifest,
             "--repo", REPO, "--title", "JinyuTV %s" % version, "--notes", notes, "--latest"])

    # 6) 上传到自有托管（客户端「检查更新 / 一键下载」的真正来源，见文件头说明）
    print("--- 上传更新托管 %s/" % UPDATE_HOST_BASE)
    sys.path.insert(0, SCRIPTS)
    from _server import connect  # noqa: E402  （凭据不进仓库）
    cli = connect()
    try:
        sftp = cli.open_sftp()
        try:
            cli.exec_command("mkdir -p %s" % UPDATE_HOST_DIR, timeout=30)[1].channel.recv_exit_status()
            for local_path in (manifest, setup):
                remote_path = "%s/%s" % (UPDATE_HOST_DIR, os.path.basename(local_path))
                try:
                    remote_size = sftp.stat(remote_path).st_size
                except FileNotFoundError:
                    remote_size = -1
                local_size = os.path.getsize(local_path)
                if remote_size == local_size:
                    print("    %s 已在服务器且大小一致，跳过" % os.path.basename(local_path))
                    continue
                print("    上传 %s（%.1f MB）…" % (os.path.basename(local_path), local_size / 1048576))
                sftp.put(local_path, remote_path)
            cli.exec_command("chmod 644 %s/*" % UPDATE_HOST_DIR, timeout=30)[1].channel.recv_exit_status()
        finally:
            sftp.close()
        # 用服务器自己 curl 一下验证公网可达（服务器连自己的公网域名走本机 nginx）
        _, out, _ = cli.exec_command(
            "curl -sS --max-time 20 -o /dev/null -w '%%{http_code}' %s/latest.json" % UPDATE_HOST_BASE,
            timeout=60)
        code = out.read().decode().strip()
        print("    公网 latest.json：HTTP %s" % ("200 ✓" if code == "200" else code + " ✗（请检查 _deploy-update-host.py）"))
    finally:
        cli.close()

    print()
    print("===== 完成 =====")
    print("  发布页    : https://github.com/%s/releases/tag/%s（存档）" % (REPO, tag))
    print("  更新清单  : %s/latest.json（客户端实际拉这里）" % UPDATE_HOST_BASE)
    print("  下载直链  : %s" % download_url)
    print("  已装旧版的用户点「检查更新」即可看到 %s" % version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
