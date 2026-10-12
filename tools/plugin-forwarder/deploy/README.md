# 插件中转服务 · 部署步骤

目标：把 Toonflow 的 key 留在服务端，客户端只见我们自己的域名。

**定案参数**：落点 `https://plugin.linke.link`（独立子域），服务器 = linke 主站那台
（`linke.link` → `47.114.76.34`，nginx 1.24 Ubuntu + Nuxt/Node + 已有 HTTPS）。

## 0. 前置条件（缺一不可）

- 一台能跑**常驻 Node 进程**的机器（Node 18+，本服务零依赖，只用内置 `fetch`）
- **HTTPS**（站点已有证书即可，不用另签）
- nginx 能加 `location`（或有等价的反代配置）
- 阿里云安全组放行 80 / 443（主站已在跑，一般已放行）

## 1. 放文件

```bash
mkdir -p /opt/plugin-forwarder
# 上传 server.mjs（仓库 tools/plugin-forwarder/server.mjs）
```

## 2. 写环境变量（key 不进仓库、不进 unit 文件）

```bash
cat > /etc/plugin-forwarder.env <<'EOF'
TOONFLOW_MARKET_KEY=sk-xxx
PORT=8787
PUBLIC_BASE_URL=https://你的站点
PROXY_DOWNLOAD=1
CACHE_SECONDS=30
EOF
chmod 600 /etc/plugin-forwarder.env
```

## 3. 起服务

```bash
cp plugin-forwarder.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plugin-forwarder
systemctl status plugin-forwarder     # 应为 active (running)
journalctl -u plugin-forwarder -f     # 看日志
```

## 4. 挂出来（二选一）

**A. 独立子域（本方案采用）** —— 整块 `server{}` 都是我们的，不会被主站路由抢走
（实测 linke.link 的 Nuxt 会把 `/v1/plugin/*` 302 跳 /home）：

```bash
# 0) 先在 DNS 加一条 A 记录：plugin.linke.link -> 47.114.76.34，等生效
nslookup plugin.linke.link 8.8.8.8        # 能解析出 IP 才算生效

# 1) 一键部署（放文件+env+systemd+nginx，含本机自检）
./setup.sh plugin.linke.link sk-你的ToonflowKey

# 2) 签证书（certbot 会自己改写 nginx 的 ssl 三行）
certbot --nginx -d plugin.linke.link
```

**B. 主站加路径**（`linke.link/v1/plugin/`，不用动 DNS）：
把 `nginx-location.conf` 的内容粘进站点 `server{}`（`^~` 保证优先于 Nuxt 兜底规则），
`nginx -t && nginx -s reload`。

## 5. 自检（在服务器本机）

```bash
curl -s -X POST https://你的站点/v1/plugin/getPlugin \
  -H 'Content-Type: application/json' \
  -d '{"page":1,"limit":5,"type":"all"}' | head -c 400
```

期望：返回 `{code:200,data:{list:[...]}}`，且 `list[].link` 都以 `https://你的站点/v1/plugin/asset/` 开头
（`PROXY_DOWNLOAD=0` 时 link 会是上游 TOS 地址，属预期）。

再验一次下载是真的能下（拿上面任一 link）：

```bash
curl -sI "上面那个 link" | head -5      # 期望 HTTP/1.1 200 + Content-Length
```

⚠️ 不要在仓库里写死/提交任何 key；本机验证脚本见 `scripts/_probe-plugin-forwarder.py`。

## 6. 客户端切换（一行）

`apps/web/src/lib/tf.ts`：

```ts
const PLUGIN_MARKET_BASE_URL = "https://你的站点";
```

改完跑 `python scripts/dev-update-both.py`（前端），再 `--only server`。
