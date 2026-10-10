/**
 * 豆包通道独立验证脚本：不经过画布 UI，直接跑通
 * 登录 → 上传参考图 → 填提示词 → 提交 → 轮询出片 → 下载落盘。
 *
 * 用法：
 *   bun run scripts/verify-doubao.ts            # 只跑一次文生视频
 *   bun run scripts/verify-doubao.ts --login    # 只做登录
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const { chromium } = await import("playwright");

const HOME = "https://www.doubao.com/";
const profileRoot = resolve(homedir(), ".toonflow-doubao-profile");
const outDir = resolve(process.cwd(), "assets", "generated");

function chromePath(): string | undefined {
  if (process.platform === "win32") {
    const list = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    return list.find((p) => existsSync(p));
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/google-chrome";
}

async function loggedIn(context: any): Promise<boolean> {
  const cookies = await context.cookies([HOME]);
  return cookies.some(
    (c: any) => (c.name === "sessionid" || c.name === "sessionid_ss") && String(c.value ?? "").trim(),
  );
}

const onlyLogin = process.argv.includes("--login");

// 真实窗口：豆包风控会拒绝 headless
const context = await chromium.launchPersistentContext(profileRoot, {
  ...(chromePath() ? { executablePath: chromePath() } : {}),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1280, height: 860 },
  args: process.platform === "win32" ? ["--window-position=120,80"] : [],
});

let exitCode = 0;
try {
  await mkdir(profileRoot, { recursive: true });
  const page = context.pages()[0] ?? (await context.newPage());

  console.log("[1/5] 打开豆包首页…");
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // context 可能已被用户关闭，先探测可用性
  let alive = true;
  try { await context.cookies([HOME]); } catch { alive = false; }

  if (!alive) {
    // 重新打开一个持久化 context（登录态在 profile 里，直接复用）
    const ctx2 = await chromium.launchPersistentContext(profileRoot, {
      ...(chromePath() ? { executablePath: chromePath() } : {}),
      headless: false,
      acceptDownloads: true,
      viewport: { width: 1280, height: 860 },
      args: process.platform === "win32" ? ["--window-position=120,80"] : [],
    });
    Object.assign(context, ctx2);
  }

  if (!(await loggedIn(context))) {
    if (onlyLogin) {
      console.log("→ 需要登录，请在浏览器里扫码，完成后本窗口会自行关闭…");
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline && !(await loggedIn(context))) {
        await page.waitForTimeout(2000);
      }
      console.log(await loggedIn(context) ? "✓ 登录成功" : "✗ 登录超时");
      exitCode = (await loggedIn(context)) ? 0 : 1;
    } else {
      console.log("✗ 未登录。请先运行：bun run scripts/verify-doubao.ts --login");
      exitCode = 2;
    }
  } else {
    console.log("✓ 已登录");
  }

  if (exitCode === 0 && !onlyLogin) {
    console.log("[2/5] 打开 AI 创作 / 视频生成入口…");
    // 直接进创作页
    for (const url of [`${HOME}chat/`, HOME]) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      const hasFile = await page.locator('input[type="file"]').count();
      if (hasFile) break;
    }

    const fileInputs = await page.locator('input[type="file"]').count();
    console.log(`   文件上传控件数量：${fileInputs}`);

    console.log("[3/5] 清理旧视频节点并填写描述…");
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach((v) => v.remove());
    });

    const editor = page.locator('textarea, [contenteditable="true"]').last();
    const hasEditor = (await editor.count()) > 0;
    if (!hasEditor) {
      console.log("✗ 找不到输入框，页面结构可能已改版。需要校准选择器。");
      await page.screenshot({ path: "assets/doubao-debug-no-editor.png", fullPage: false });
      console.log("   已截图：assets/doubao-debug-no-editor.png");
      exitCode = 3;
    } else {
      const prompt = "一只橘猫在窗台上打哈欠，午后阳光，暖色调，镜头缓慢推进";
      await editor.click();
      await editor.fill(prompt);
      await page.waitForTimeout(1000);

      const submit = page.locator('button').filter({ hasText: /生成|发送|提交/ }).last();
      const hasSubmit = (await submit.count()) > 0;
      if (!hasSubmit) {
        console.log("✗ 找不到提交按钮");
        await page.screenshot({ path: "assets/doubao-debug-no-submit.png" });
        exitCode = 4;
      } else {
        console.log("[4/5] 点击提交…");
        await submit.click();

        console.log("[5/5] 轮询等待出片（最长 12 分钟）…");
        const deadline = Date.now() + 12 * 60 * 1000;
        let src = "";
        let lastState = "";
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          const state = await page.evaluate(() => {
            const body = document.body.innerText || "";
            if (/额度已用完|已达上限|quota|免费额度/i.test(body)) return "quota";
            const v = Array.from(document.querySelectorAll("video")).at(-1) as any;
            const s = v?.currentSrc || v?.src || v?.getAttribute("src") || v?.poster || "";
            if (s) return `video:${s.slice(0, 60)}`;
            if (/生成失败|出错了|请重试/.test(body)) return "error";
            if (/生成中|正在生成|排队中|创作中/.test(body)) return "running";
            return "waiting";
          });
          if (state !== lastState) {
            console.log(`   ${new Date().toLocaleTimeString()} → ${state}`);
            lastState = state;
          }
          if (state === "quota") {
            console.log("✗ 今日免费额度已用完");
            exitCode = 5;
            break;
          }
          if (state === "error") {
            console.log("✗ 页面提示生成失败");
            await page.screenshot({ path: "assets/doubao-debug-gen-failed.png" });
            exitCode = 6;
            break;
          }
          if (state.startsWith("video:")) {
            src = await page.evaluate(() => {
              const v = Array.from(document.querySelectorAll("video")).at(-1) as any;
              return v?.currentSrc || v?.src || v?.getAttribute("src") || v?.poster || "";
            });
            break;
          }
        }

        if (src) {
          console.log("✓ 出片，开始下载…");
          await mkdir(outDir, { recursive: true });
          const name = `doubao-${Date.now()}.mp4`;
          const res = await fetch(src);
          const bytes = new Uint8Array(await res.arrayBuffer());
          await writeFile(resolve(outDir, name), bytes);
          console.log(`✓ 已保存：${resolve(outDir, name)}（${(bytes.length / 1048576).toFixed(2)} MB）`);
        } else if (exitCode === 0) {
          console.log("✗ 等待超时，未拿到视频");
          await page.screenshot({ path: "assets/doubao-debug-timeout.png" });
          console.log("   已截图：assets/doubao-debug-timeout.png");
          exitCode = 7;
        }
      }
    }
  }
} catch (error) {
  console.error("✗ 异常：", error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await context.close().catch(() => undefined);
}

process.exit(exitCode);
