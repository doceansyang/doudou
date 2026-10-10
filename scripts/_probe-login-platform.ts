// 验证「绑定 Dola 账号时打开的是海外站点」。
//
// 直接调核心的 openLogin（它会把浏览器开到对应平台并等用户登录）。
// 登录要人工扫码，这里只验证**前 25 秒**：浏览器起来了、打开的地址对不对。
// 用独立 profile 目录，不碰真实账号。
//
// 用法：bun scripts/_probe-login-platform.ts [doubao|dola]
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openLogin } from "./doubao-rpa-core.ts";

const accountType = (process.argv[2] === "doubao" ? "doubao" : "dola") as "doubao" | "dola";
const profileDir = resolve(tmpdir(), `jinyutv-login-probe-${accountType}`);

console.log(`[探针] 平台=${accountType}，profile=${profileDir}`);
await openLogin(profileDir, accountType);
console.log(`[探针] openLogin 返回（本次不会发生：需要人工扫码）`);
console.log(`[探针] profile 目录已创建：${existsSync(profileDir)}`);
