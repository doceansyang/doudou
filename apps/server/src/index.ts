import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createApp } from "./app";

// 本机常见 http_proxy（实测本机就有），会把发往 127.0.0.1 的请求也交给代理，
// 结果是本地探测/调用被拦成 502 —— 之前排查豆包 RPA 时就踩过这个坑。
// 这里由服务自己把本地地址加入 no_proxy，用户无需再关心启动时的环境变量。
for (const key of ["NO_PROXY", "no_proxy"]) {
  const current = process.env[key];
  const additions = "127.0.0.1,localhost,::1";
  process.env[key] = current ? `${current},${additions}` : additions;
}

const startTime = Date.now();
const realPort = 3000;
// 源码位于 apps/server/src，生产构建位于 build/server，均从文件位置定位根目录。
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  dataDirectory,
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: 暂不安装内置团队，随团队打包一同恢复。
  // agentsRoot: resolve(appDirectory, "build/agents"),
  providersRoot: resolve(appDirectory, fromSource ? "packages/providers/src" : "build/providers"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
});
/**
 * 确保豆包 RPA 服务在运行。
 *
 * 为什么它是独立进程：JinyuTV 的供应商跑在 node:vm 沙箱里，官方禁止 import，
 * 沙箱内没有 fs / path / os / process，也没有 playwright；而豆包必须靠真实浏览器。
 * 所以浏览器自动化放在 scripts/doubao-rpa-service.ts（独立进程，完整 Node 能力）。
 *
 * 以前需要用户手动启动它，很容易漏（漏了就会报「无法连接本地 RPA 服务」）。
 * 这里随主服务自动拉起：先用健康检查探测，已在跑就不重复启动。
 * 用 process.execPath（bun 本体）启动，不依赖 PATH 里的 bun。
 */
async function ensureDoubaoRpaService(): Promise<void> {
  const healthUrl = "http://127.0.0.1:18077/health";
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      console.log("[豆包RPA] 已在运行（端口 18077）");
      return;
    }
  } catch { /* 未运行，继续拉起 */ }

  const script = resolve(appDirectory, "scripts", "doubao-rpa-service.ts");
  if (!existsSync(script)) {
    console.log(`[豆包RPA] 未找到服务脚本，跳过自动启动：${script}`);
    return;
  }
  try {
    const child = spawn(process.execPath, ["run", script], {
      cwd: appDirectory,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, DOUBAO_RPA_PORT: "18077" },
    });
    child.unref();
    console.log("[豆包RPA] 已随主服务自动启动（端口 18077）");
  } catch (error) {
    console.log(`[豆包RPA] 自动启动失败（不影响其他功能）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 主机授权的**服务端二次校验**。
 *
 * 为什么启动器已经校验过了还要再来一次：
 *   启动器的门可以被绕过 —— 用户双击 `start-server.bat` 就能直接起服务，
 *   前端照样能用（等于没锁）。所以服务端也要自己确认一次授权。
 *
 * 为什么放在 `listen` **之前**：端口都不开，前端连都连不上，
 * 这才是真正的「不可用」，而不是弹个提示还能点。
 *
 * 开发态（`NODE_ENV=dev` / 直接 bun 跑源码）跳过校验，
 * 否则每次改代码都要先激活，太妨碍开发。
 */
async function ensureLicensed(appDir: string, fromSource: boolean): Promise<boolean> {
  if (process.env.JINYUTV_SKIP_LICENSE === "1") {
    console.log("[授权] 已通过环境变量跳过校验（开发用）");
    return true;
  }
  const licenseFile = resolve(appDir, "data", "license.json");
  if (!existsSync(licenseFile)) {
    console.error(`[授权] 未找到授权文件：${licenseFile}`);
    console.error("[授权] 请通过桌面快捷方式启动 JinyuTV，在弹出的窗口里输入授权码激活。");
    return false;
  }
  // 复用 license-bridge.ts（授权逻辑的唯一来源），不在服务端另写一份
  const bridge = resolve(appDir, "scripts", "license", "license-bridge.ts");
  if (!existsSync(bridge)) {
    console.error(`[授权] 未找到授权校验脚本：${bridge}（安装可能不完整）`);
    return false;
  }
  return new Promise((done) => {
    try {
      const child = spawn(process.execPath, ["run", bridge], {
        cwd: appDir,
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env },
      });
      let out = "";
      child.stdout?.on("data", (chunk) => { out += String(chunk); });
      child.on("error", (error) => {
        console.error(`[授权] 校验进程启动失败：${error.message}`);
        done(false);
      });
      child.on("close", () => {
        const line = out.trim().split("\n").pop() || "";
        if (line.includes('"ok":true')) {
          console.log("[授权] 校验通过，本机已激活");
          done(true);
        } else {
          const reason = line.match(/"reason":"([^"]*)"/)?.[1] || "授权无效";
          console.error(`[授权] 校验未通过：${reason}`);
          done(false);
        }
      });
      child.stdin?.write(JSON.stringify({ action: "verify", licenseFile }));
      child.stdin?.end();
      //兜底：bridge 卡死不能让服务永远不启动
      setTimeout(() => {
        if (!child.killed) { try { child.kill(); } catch { /* 已退出 */ } }
      }, 30000).unref?.();
    } catch (error) {
      console.error(`[授权] 校验异常：${error instanceof Error ? error.message : String(error)}`);
      done(false);
    }
  });
}

const licensed = await ensureLicensed(appDirectory, fromSource);
if (!licensed) {
  console.error("=".repeat(64));
  console.error("[授权] 本机未激活，服务不会启动。");
  console.error("[授权] 请双击 JinyuTV 图标启动，在弹出的激活窗口里输入授权码。");
  console.error("=".repeat(64));
  process.exit(3);
}

const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
const listener = app.listen(realPort, async () => {
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  console.log(`[服务启动成功]: http://localhost:${realPort}`);
  console.log(`[启动耗时]: ${(Date.now() - startTime).toFixed(2)}ms`);
  // 不阻塞启动：RPA 服务晚几秒就绪也不影响画布使用。
  void ensureDoubaoRpaService();
});

// 出片通常要 3～5 分钟，而 HTTP 服务器默认的 requestTimeout 是 300 秒：
// 一旦超过就会被强制断开 —— 豆包那边视频明明已经生成好了，
// 画布节点里却拿不到结果（现象就是「生成成功但没回到节点」）。
// 这里关掉总请求超时；长任务的时长控制交给业务流程自己的超时逻辑。
try {
  (listener as unknown as { requestTimeout?: number }).requestTimeout = 0;
  console.log("[超时调优] HTTP 总请求超时已关闭（requestTimeout=0，避免 5 分钟以上出片被掐断）");
} catch (error) {
  console.log(`[超时调优] 设置 requestTimeout 失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`);
}
