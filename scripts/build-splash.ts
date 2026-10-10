/**
 * 构建 Windows 启动动画线程（等价于 apps/desktop/scripts/build.ts 里的 Bun.build 那段）。
 * 单独拆成脚本，是为了避开 `bun -e "...双引号..."` 在 Windows cmd 下被吃掉引号的问题。
 */
import { resolve } from "node:path";

const projectDir = resolve(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [resolve(projectDir, "packages/startup/src/windowsSplashWorker.ts")],
  outdir: resolve(projectDir, "build/desktop/startup"),
  target: "bun",
  minify: true,
});

if (!result.success) throw new AggregateError(result.logs, "启动动画线程构建失败。");
console.log("启动动画 worker 已构建到 build/desktop/startup");
