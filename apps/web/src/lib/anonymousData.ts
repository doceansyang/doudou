/**
 * 匿名使用统计 —— 本产品**不发送任何数据**。
 *
 * ## 为什么这里是空实现
 * 旧实现会把使用统计 POST 到上游的私有路由 `/web/telemetry/report`。品牌替换脚本
 * （`scripts/rebrand-api-to-linke.py`）把全仓的 `https://api.toonflow.net` **一律**
 * 换成了 `https://api.linke.link`，但那条路由只有上游自己的后台才有，linke 网关上没有：
 *
 * - `POST https://api.linke.link/web/telemetry/report` → HTTP 200，但 body 是**站点首页 HTML**
 *   （被 Nuxt 兜底路由接走），数据发出去即被丢弃，等于「发了个寂寞」；
 * - `POST https://api.toonflow.net/web/telemetry/report` → 该路由真实存在
 *   （返回 `{"code":200,"data":{"validationStatus":"invalid"}}`）。
 *
 * 用户决策（2026-10-13）：**干脆不发**。数据外流比少一个埋点严重，本产品也不依赖遥测做决策。
 *
 * ## 保留的东西
 * 对外接口（`track` / `startAgent` / `observeCanvas`）**原样保留**，调用点一行都不用改：
 * 内部两个变量恒为空，所有调用天然降级成空操作。`registerAnonymousData()` 仍返回卸载函数，
 * 以兼容 `app.onUnmount(registerAnonymousData())`。
 *
 * 恢复方式：从 git 历史取回本文件的上一版即可，采集与上报逻辑完整保留在历史里。
 */

type UsageEvent = "onboarding.complete" | "onboarding.skip" | "workspace.canvas" | "workspace.document";
type AgentOutcome = "success" | "failed" | "cancelled";
type CanvasSnapshot = { nodes: readonly { type?: string }[]; edgeCount: number };

// 以下两个变量恒为空 —— 调用方走的是可选链，因此所有统计调用天然是空操作。
let readCanvas: (() => CanvasSnapshot | undefined) | undefined;
let collector: { track: (event: UsageEvent) => void; startAgent: () => (outcome: AgentOutcome) => void } | undefined;

const anonymousData = {
  track(event: UsageEvent) {
    collector?.track(event);
  },
  startAgent() {
    return collector?.startAgent() ?? (() => {});
  },
  observeCanvas(read: () => CanvasSnapshot | undefined) {
    readCanvas = read;
    return () => {
      if (readCanvas === read) readCanvas = undefined;
    };
  },
};
export default anonymousData;

/** 有意留空：不再注册任何采集与上报。返回空卸载函数以兼容调用方。 */
export function registerAnonymousData() {
  return () => {};
}
