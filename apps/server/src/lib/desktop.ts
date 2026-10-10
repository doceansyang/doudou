import type { Request, Response, NextFunction } from "express";
import { error } from "@/lib/responseFormat";
import { getStandaloneRuntime, isDesktopBuild } from "@/utils/desktop/standalone";

/**
 * 判断某个请求是否属于「更新」接口。
 *
 * ⚠️ 必须用 `originalUrl`（完整路径），**不能用 `req.path`**：
 *   · 在中间件里（挂在 `/api/desktop` 上）`req.path` 是挂载点之后的相对值 `/update`；
 *   · 在路由处理器里 `req.path` 又变回完整值 `/api/desktop/update`。
 *   同一个判断函数在两处语义不同 → 路由处理器里恒为 false →
 *   中间件放行了、处理器却抛 404（现象：接口"时好时坏"、日志无中间件记录）。
 */
function isUpdateRequest(req: Request): boolean {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  return path === "/api/desktop/update" || path.startsWith("/api/desktop/update/");
}

export default function desktopRequest(req: Request, res: Response, next: NextFunction) {
  // 我们的桌面发行版（NSIS + 内嵌 WebView2）没有原生桌面运行时，但**更新检查**必须有。
  // 这里只为「更新」接口放行，具体实现由 resolveDesktopRuntime() 提供；
  // 其余 /api/desktop/* 仍然保持 404 —— 我们确实给不出原生文件对话框等能力，
  // 让它们抛「不支持」的错误反而更难排查。
  if (!req.app.locals.desktop && !(isDesktopBuild() && isUpdateRequest(req))) {
    // 诊断：环境变量没到位时用户只会看到「仅在桌面客户端中可用」，极难定位。
    console.error(
      `[desktop] 拒绝 ${req.method} ${req.originalUrl}` +
        ` path=${req.path} toonflowDesktop=${JSON.stringify(process.env.toonflowDesktop)}` +
        ` isUpdate=${isUpdateRequest(req)} hasNative=${!!req.app.locals.desktop}`,
    );
    return res.status(404).json(error("此接口仅在桌面客户端中可用", null, 404));
  }
  if (req.method !== "POST") return next();
  const localOrigin = `http://${req.get("host")}`;
  const origin = req.get("origin");
  // ACT: WebView2 可能省略 Origin；仅缺失时使用带路径分隔符的同源 Referer。
  const isSameOrigin = origin === undefined ? req.get("referer")?.startsWith(`${localOrigin}/`) : origin === localOrigin;
  // 127.0.0.1 与 localhost 都是「本机」：启动器打开的地址是 localhost，
  // 只认 127.0.0.1 会把本机页面自己的请求也挡掉（403「仅允许桌面页面发起操作」）。
  const localHost = req.hostname === "127.0.0.1" || req.hostname === "localhost" || req.hostname === "[::1]";
  if (!localHost || !isSameOrigin || req.get("x-toonflow-desktop") !== "1") {
    return res.status(403).json(error("仅允许桌面页面发起操作。", null, 403));
  }
  next();
}

/**
 * 取当前请求的桌面运行时：原生外壳写入的优先；否则在桌面发行版的更新接口上
 * 用我们自己的最小实现（见 utils/desktop/standalone.ts）。
 */
export function resolveDesktopRuntime(req: Request) {
  return req.app.locals.desktop ?? (isDesktopBuild() && isUpdateRequest(req) ? getStandaloneRuntime() : undefined);
}
