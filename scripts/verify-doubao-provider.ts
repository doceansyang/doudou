/**
 * 端到端验证豆包供应商。
 *
 * 直接调用 provider 的 generateVideo（不经过画布），这样失败时能拿到最清晰的错误。
 *
 *   bun run scripts/verify-doubao-provider.ts --login   # 只打开浏览器扫码登录
 *   bun run scripts/verify-doubao-provider.ts           # 真实生成一条 5 秒视频
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PROFILE = resolve(homedir(), ".toonflow-doubao-profile");

async function loginState(): Promise<boolean> {
  const { chromium } = await import("playwright");
  const executable = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].find((path) => existsSync(path));
  const context = await chromium.launchPersistentContext(PROFILE, {
    ...(executable ? { executablePath: executable } : {}),
    headless: true,
  });
  try {
    const cookies = await context.cookies(["https://www.doubao.com/"]);
    const hit = cookies.filter((c) => c.name === "sessionid" || c.name === "sessionid_ss");
    return hit.some((c) => String(c.value || "").trim());
  } finally {
    await context.close().catch(() => undefined);
  }
}

console.log("=== 豆包登录态 ===");
console.log("  已登录:", (await loginState()) ? "✓ 是" : "✗ 否");

if (process.argv.includes("--login")) {
  const provider: any = (await import("../packages/providers/src/media/doubaoAccount.ts")).default;
  console.log("\n打开浏览器，请扫码登录（最长等 10 分钟）…");
  await provider.openLogin?.();
  console.log("登录流程结束，登录态:", (await loginState()) ? "✓ 有效" : "✗ 仍未登录");
  process.exit(0);
}

const provider: any = (await import("../packages/providers/src/media/doubaoAccount.ts")).default;
console.log("\n=== 开始生成 ===");
console.log("  供应商:", provider.label, provider.version);
console.log("  模型:", provider.models?.[0]?.label);

const started = Date.now();
try {
  const assets = await provider.generateVideo({
    model: "Seedance 2.0 Fast",
    prompt: "一只橘猫在洒满阳光的木地板上伸懒腰，窗外是春天的樱花，暖色调，治愈风格",
    ratio: "16:9",
    duration: 5,
    sound: false,
    images: [],
  });
  console.log("\n✓ 生成成功，耗时", Math.round((Date.now() - started) / 1000), "秒");
  for (const asset of assets || []) {
    console.log("  产物:", asset.url, asset.mimeType);
  }
} catch (error: any) {
  console.error("\n✗ 生成失败，耗时", Math.round((Date.now() - started) / 1000), "秒");
  console.error("  ", error?.message || error);
  process.exitCode = 1;
}
