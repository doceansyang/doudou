#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「检查更新」的清单与安装包托管到自己的服务器：https://linke.link/jinyutv-update/*

背景：客户端更新源原本写死 GitHub Releases，但用户机器（以及国内大部分网络）
直连 GitHub 会超时 —— 软件进程里的 bun fetch 不走系统代理，「检查更新」永远失败。
自己的阿里云服务器访问 GitHub 实测 1.2s 拿到 latest.json，所以在这里做静态托管：
发版脚本把 latest.json + Setup.exe 传上来，nginx 直接吐文件，客户端只认 linke.link。

安全规矩（与 _deploy-path-prefix.py 一致）：
  · 改 nginx 前先备份，nginx -t 不过就还原并退出，绝不带病 reload
  · 幂等：已挂过就跳过，不重复追加
  · 只**插入**一个 location 块，不重写、不整理原有配置
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _server import connect  # noqa: E402

BASE = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发"
SITE_CONF = "/etc/nginx/conf.d/easyai-proxy.conf"
WEB_ROOT = "/var/www/jinyutv-update"
PUBLIC_BASE = "https://linke.link/jinyutv-update"

# 插入锚点：放在「插件市场中转」那块之前（同属追加型配置，彼此不干扰）
ANCHOR = "    # ===== JinyuTV 插件市场中转（自动生成，只追加）====="

LOCATION_BLOCK = f"""    # ===== JinyuTV 更新托管（自动生成，只追加）=====
    # 「检查更新」清单与安装包的国内源：GitHub 直连在国内超时，客户端只认 linke.link。
    # 文件由 scripts/release.py 发版时上传（paramiko sftp），nginx 只做静态吐文件。
    location ^~ /jinyutv-update/ {{
        alias {WEB_ROOT}/;
        add_header Cache-Control "public, max-age=60";
    }}

"""


def sh(cli, cmd, timeout=120):
    _, out, err = cli.exec_command(cmd, timeout=timeout)
    return out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")


def main():
    cli = connect()
    sftp = cli.open_sftp()
    try:
        # ---- 1. 备份 ----
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{SITE_CONF}.bak-jinyutv-update-{stamp}"
        sh(cli, f"cp -n {SITE_CONF} {backup}")
        print(f"① 已备份：{backup}")

        with sftp.open(SITE_CONF, "r") as handle:
            original = handle.read().decode("utf-8")

        # ---- 2. 幂等：已挂过就跳过 ----
        if "location ^~ /jinyutv-update/" in original:
            print("② 配置里已有 /jinyutv-update/ 路由，跳过插入")
        else:
            if ANCHOR not in original:
                print(f"   ✘ 找不到锚点 {ANCHOR!r}，不敢乱改配置")
                sys.exit(1)
            patched = original.replace(ANCHOR, LOCATION_BLOCK + ANCHOR, 1)
            with sftp.open(SITE_CONF, "w") as handle:
                handle.write(patched.encode("utf-8"))
            print("② 已插入 location ^~ /jinyutv-update/")

        # ---- 3. 建目录 ----
        sh(cli, f"mkdir -p {WEB_ROOT} && chmod 755 {WEB_ROOT}")
        print(f"③ 托管目录就绪：{WEB_ROOT}")

        # ---- 4. 上传当前版本的两个资产（幂等：同名跳过） ----
        for local_name in ("latest.json", "JinyuTV-3.0.0-Setup.exe"):
            local_path = os.path.join(BASE, local_name)
            if not os.path.isfile(local_path):
                print(f"   ⚠ 本地没有 {local_name}，跳过上传")
                continue
            remote_path = f"{WEB_ROOT}/{local_name}"
            try:
                remote_size = sftp.stat(remote_path).st_size
            except FileNotFoundError:
                remote_size = -1
            local_size = os.path.getsize(local_path)
            if remote_size == local_size:
                print(f"④ {local_name} 已在服务器且大小一致，跳过")
                continue
            print(f"④ 上传 {local_name}（{local_size // 1024} KB）…")
            sftp.put(local_path, remote_path)
        sh(cli, f"chmod 644 {WEB_ROOT}/*")

        # ---- 5. 语法检查，不过就还原 ----
        out, err = sh(cli, "nginx -t 2>&1")
        ok = "test is successful" in (out + err)
        print(f"⑤ nginx -t：{'通过' if ok else '失败'}")
        if not ok:
            print(out + err)
            sh(cli, f"cp {backup} {SITE_CONF}")
            print("   ↩ 已还原配置")
            sys.exit(1)
        sh(cli, "nginx -s reload")
        time.sleep(1)
        print("⑥ nginx 已 reload")

        # ---- 6. 公网验证 ----
        out, _ = sh(cli, f"curl -sS --max-time 20 -o /tmp/u-latest.json -w 'HTTP %{{http_code}} %{{time_total}}s %{{size_download}}B' {PUBLIC_BASE}/latest.json")
        print(f"⑦ 公网 {PUBLIC_BASE}/latest.json → {out.strip()}")
        out, _ = sh(cli, "head -c 90 /tmp/u-latest.json")
        print("   " + out.strip().replace("\n", " "))
        out, _ = sh(cli, f"curl -sSI --max-time 20 {PUBLIC_BASE}/JinyuTV-3.0.0-Setup.exe | head -4")
        print(f"⑧ 安装包直链响应头：\n{out.strip()}")
    finally:
        sftp.close()
        cli.close()


if __name__ == "__main__":
    main()
