import type { Request, Response, NextFunction } from "express";
import { error } from "@/lib/responseFormat";
import { getStandaloneRuntime, isDesktopBuild, isUpdatePath } from "@/utils/desktop/standalone";

export default function desktopRequest(req: Request, res: Response, next: NextFunction) {
  // 我们的桌面发行版（NSIS + 内嵌 WebView2）没有原生桌面运行时，但**更新检查**必须有。
  // 这里只为「更新」接口放行，具体实现由 resolveDesktopRuntime() 提供；
  // 其余 /api/desktop/* 仍然保持 404 —— 我们确实给不出原生文件对话框等能力，
  // 让它们抛「不支持」的错误反而更难排查。
  if (!req.app.locals.desktop && !(isDesktopBuild() && isUpdatePath(req.path))) {
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
  return req.app.locals.desktop ?? (isDesktopBuild() && isUpdatePath(req.path) ? getStandaloneRuntime() : undefined);
}
