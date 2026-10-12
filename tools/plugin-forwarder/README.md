# 插件中转服务（plugin-forwarder）

**一句话**：把 Toonflow 的插件市场接口包一层我们自己的地址 —— 客户端只认我们，
**Toonflow 的 key 留在服务端**，用户既看不到来源、也不需要任何 key。

## 为什么不是"把 key 内置进客户端"

客户端是要发到用户手上的。凭据一旦随安装包发出去就**收不回来**：被扒出来只能靠发新版补救，
而且那份 key 关联的账号会被别人用。所以 key 只能放服务端。

## 它长什么样

| 项目 | 说明 |
|---|---|
| 文件 | `server.mjs`，**单文件、零依赖**（Node 18+ / Bun 都能跑） |
| 接口 | `POST /v1/plugin/getPlugin`、`POST /v1/plugin/toggleCollection`，**形状与 Toonflow 完全一致** |
| 下载代理 | `GET /v1/plugin/asset/<文件名>?src=…` —— 列表里的 `link` 会被改写成走这里，见下节 |
| 放行的路径 | 只有上面这些，其余一律 404 —— 它**不是**通用代理 |
| 上游报错 | 只进服务端日志，对客户端一律 `502 + 插件服务暂时不可用`（不泄漏来源措辞） |
| 缓存 | 进程内 30 秒（`CACHE_SECONDS` 可调）。**不能调大**：条目里的下载链是火山 TOS 预签名，`X-Tos-Expires=3600`，**1 小时就失效**。缓存的必须是**改写前**的原始体 —— 改写要用"本次请求的 Host"拼地址 |
| 限流 | 每 IP 每分钟 120 次 |
| CORS | 已带 `Access-Control-Allow-Origin: *` 与预检处理（客户端是 localhost 页面，跨域必需） |

## 去品牌（两道，都默认开）

上游的下载域名是 **`toonflow.tos-cn-beijing.volces.com`** —— bucket 名就叫 toonflow。
所以只把接口地址指过来还不够，下载那条链也得收进来：

1. **改写**：`getPlugin` 返回的每个 `link` 换成 `https://<本服务>/v1/plugin/asset/<文件名>?src=<原地址>`。
   客户端侧（以及日志、抓包）从此**看不到 toonflow 域名**。
   文件名会放进 path 末段 —— 服务端安装时若没带 `fileName`，会从 URL 末段取（这是既有约定）。
2. **代理**：客户端拿改写后的地址来取 → 本服务去 TOS 取 → **流式**回传（插件几 MB，不整个读进内存）。

> ⚠️ 代理是**严格白名单**：只放行火山 TOS（`*.tos-*.volces.com`）且路径以 `/plugins/` 开头的地址，
> 其余一律 403。放开这两条就等于给全世界一个免费代理，还能被拿去打内网（SSRF）。

想关掉下载代理（例如中转带宽不够）就设 `PROXY_DOWNLOAD=0`：`link` 恢复上游原样，
安装照旧能用，只是那个域名会重新出现在客户端侧。

## 跑起来

```bash
# 直接跑（前台）
TOONFLOW_MARKET_KEY=sk-xxxx PORT=8787 node tools/plugin-forwarder/server.mjs
```

环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `TOONFLOW_MARKET_KEY` | ✅ | Toonflow 那边的 key。**建议单独开一个没有余额的账号**专门放这把 |
| `PORT` | | 默认 `8787` |
| `CACHE_SECONDS` | | 默认 `30`，设 `0` 关掉缓存 |
| `PROXY_DOWNLOAD` | | 默认开；设 `0` 则不改写 `link`（见上节） |
| `PUBLIC_BASE_URL` | | 本服务的对外地址（如 `https://api.linke.link`）。不配则按请求的 `Host` / `X-Forwarded-Host` 推断 |

自检（会自己拉起服务、跑完杀掉；连**下载代理的字节数是否与直连一致**、白名单是否生效都验）：

```bash
python scripts/_probe-plugin-forwarder.py
```

## 接到我们的域名上（二选一）

### A. 本机/云主机 + nginx（推荐）

```nginx
# 只把插件这一条路径转给中转服务，其它路径照旧给 new-api
location /v1/plugin/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

配上 HTTPS 证书后，客户端访问 `https://<你的域名>/v1/plugin/getPlugin` 就等于访问本服务。

> ⚠️ 反代要**原样透传响应头**（默认行为即可），否则客户端会因缺 CORS 头被浏览器拦下。

### B. Cloudflare Worker（不用自己的服务器）

把 `server.mjs` 里的转发逻辑搬进 Worker（`fetch` 用法一样），
`TOONFLOW_MARKET_KEY` 放 Worker 的 secret，路由挂 `/v1/plugin/*`。

## 接好之后，客户端只改一行

`apps/web/src/lib/tf.ts`：

```ts
export const PLUGIN_MARKET_BASE_URL = "https://api.linke.link";   // 原来指 api.toonflow.net
```

改完重新构建即可 —— 客户端从此**不需要任何插件市场 key**，界面上也不会再出现 Toonflow。
