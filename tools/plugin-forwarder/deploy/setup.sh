#!/usr/bin/env bash
# 插件中转服务 —— 服务器一键部署（独立子域方案）
#
# 用法（root）：
#   ./setup.sh plugin.linke.link sk-你的ToonflowKey
#
# 做四件事：放文件 → 写环境变量 → 起 systemd → 挂 nginx。
# 证书不在这里签发（必须等 DNS 生效），脚本末尾会给出 certbot 命令。
# key 只写进 /etc/plugin-forwarder.env（600），不进仓库、不进 unit 文件。

set -euo pipefail

DOMAIN="${1:-}"
KEY="${2:-}"

if [ -z "$DOMAIN" ] || [ -z "$KEY" ]; then
  echo "用法：$0 <子域名> <Toonflow key>" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)/server.mjs"

if [ ! -f "$SRC" ]; then
  echo "找不到 server.mjs：$SRC" >&2
  exit 1
fi

# Node 18+：本服务用内置 fetch / AbortSignal.timeout
if ! command -v node >/dev/null 2>&1; then
  echo "未安装 node，请先装 Node 18+" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 版本过低（$NODE_MAJOR），需要 18+" >&2
  exit 1
fi

echo "── 1/4 放文件到 /opt/plugin-forwarder"
install -d -m 755 /opt/plugin-forwarder
install -m 644 "$SRC" /opt/plugin-forwarder/server.mjs

echo "── 2/4 写环境变量 /etc/plugin-forwarder.env"
umask 077
cat > /etc/plugin-forwarder.env <<EOF
TOONFLOW_MARKET_KEY=$KEY
PORT=8787
PUBLIC_BASE_URL=https://$DOMAIN
PROXY_DOWNLOAD=1
CACHE_SECONDS=30
EOF
chmod 600 /etc/plugin-forwarder.env

echo "── 3/4 起 systemd"
install -m 644 "$HERE/plugin-forwarder.service" /etc/systemd/system/plugin-forwarder.service
systemctl daemon-reload
systemctl enable --now plugin-forwarder
sleep 1
# 起不来就在这里停住：后面挂 nginx 也没意义，先看 journalctl
if ! systemctl is-active --quiet plugin-forwarder; then
  echo "服务未运行，请查：journalctl -u plugin-forwarder -n 50" >&2
  exit 1
fi
echo "   服务已运行"

# 本机自检：直接打本地端口，先确认服务本身是好的（与 nginx / DNS 无关）
echo "   本机自检："
curl -sS -m 20 -X POST http://127.0.0.1:8787/v1/plugin/getPlugin \
  -H 'Content-Type: application/json' \
  -d '{"page":1,"limit":3,"type":"all"}' | head -c 200
echo

echo "── 4/4 挂 nginx"
sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/nginx-subdomain.conf" > "/etc/nginx/sites-available/$DOMAIN.conf"
ln -sfn "/etc/nginx/sites-available/$DOMAIN.conf" "/etc/nginx/sites-enabled/$DOMAIN.conf"
nginx -t
systemctl reload nginx

cat <<EOF

──── 部署完成 ────
1) DNS：把 $DOMAIN 的 A 记录指向本机公网 IP，等生效。
2) 证书：certbot --nginx -d $DOMAIN
3) 线上自检（走域名）：
   curl -sS -X POST https://$DOMAIN/v1/plugin/getPlugin \\
     -H 'Content-Type: application/json' -d '{"page":1,"limit":3,"type":"all"}' | head -c 300
   期望：code:200，且 list[].link 以 https://$DOMAIN/v1/plugin/asset/ 开头。
4) 再验下载能下（拿上一步任一 link）：
   curl -sI "<那个 link>" | head -3        # 期望 200 + Content-Length
5) 通过后告诉我，我改客户端一行（PLUGIN_MARKET_BASE_URL）并重建两个实例。
EOF
