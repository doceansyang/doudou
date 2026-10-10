/**
 * 复现「添加自定义供应商 → 获取模型列表」失败，并抓真实原因。
 *
 * 目的（用户 2026-10-10 反馈）：弹窗里只显示通用兜底文案
 * 「获取模型列表失败，请检查连接配置」，
 * 而服务端其实返回了准确信息「获取模型列表失败（HTTP 401），请检查 API 地址、协议和密钥」。
 * 要弄清到底是**请求没发出去 / 响应没回来 / 拿到了但被丢掉**里的哪一种。
 *
 * 因此记录三件事：
 *   ① 浏览器实际发出了什么请求（URL / method / payload）
 *   ② 服务端实际返回了什么（状态码 / 原始 body）
 *   ③ 页面上最终显示的提示文字
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = join(process.cwd(), "scripts", "_out");
const lines: string[] = [];
const log = (t: string) => {
  lines.push(t);
  console.log(t);
};

const browser = await (await import("playwright")).chromium.launch({
  executablePath: CHROME,
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const seen: Array<{ url: string; method: string; body?: string; status?: number; resp?: string }> = [];
page.on("request", (r) => {
  if (r.url().includes("/api/providers/models")) seen.push({ url: r.url(), method: r.method(), body: r.postData() || "" });
});
page.on("response", async (r) => {
  const hit = seen.find((s) => s.url === r.url() && s.status === undefined);
  if (!hit) return;
  hit.status = r.status();
  hit.resp = (await r.text().catch(() => "")).slice(0, 300);
});
page.on("console", (m) => {
  if (m.type() === "error") log(`  [console.error] ${m.text().slice(0, 160)}`);
});
page.on("pageerror", (e) => log(`  [pageerror] ${String(e.message).split("\n")[0]}`));

try {
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  // 打开设置 → 文本模型 → 添加自定义供应商
  await page.locator('button[aria-label="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(1500);
  await page.locator("button").filter({ hasText: "添加自定义供应商" }).first().click();
  await page.waitForTimeout(2000);

  const inputs = page.locator('.el-dialog input[type="text"], .el-dialog input:not([type])');
  await inputs.nth(0).fill("qwen");                                    // Provider ID
  await inputs.nth(1).fill("qwen3.8-max");                            // 显示名称
  await inputs.nth(2).fill("https://dashscope.aliyuncs.com/compatible-mode/v1"); // API 地址
  const keyInput = page.locator('.el-dialog input[type="password"]').first();
  if (await keyInput.count()) await keyInput.fill("sk-invalid-diagnosis");
  await page.waitForTimeout(400);

  // 先看这个弹窗里到底有哪些按钮（文案可能与预期不同）
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".el-dialog button")).map((b) => ({
      text: (b.textContent || "").trim(),
      disabled: (b as HTMLButtonElement).disabled,
      cls: b.className,
    })),
  );
  log("=== 弹窗内按钮 ===");
  buttons.forEach((b) => log(`  「${b.text}」 disabled=${b.disabled} cls=${b.cls.slice(0, 60)}`));
  log("");

  const fetchBtn = page.locator(".el-dialog button").filter({ hasText: "获取模型列表" }).first();
  log(`按钮数量: ${await fetchBtn.count()}`);
  if (await fetchBtn.count()) {
    log(`按钮 disabled=${await fetchBtn.isDisabled()}`);
    // 用 evaluate 直接点，绕开 playwright 的可点击性检查
    await fetchBtn.evaluate((b: HTMLButtonElement) => b.click());
  }
  await page.waitForTimeout(9000);

  log("=== ① 浏览器发出的请求 ===");
  if (!seen.length) log("  （没有发出 /api/providers/models 请求！）");
  for (const s of seen) log(`  ${s.method} ${s.url}\n    payload: ${s.body.slice(0, 200)}`);

  log("");
  log("=== ② 服务端返回 ===");
  for (const s of seen) log(`  HTTP ${s.status}  ${s.resp}`);

  log("");
  log("=== ③ 页面最终显示的提示 ===");
  const hints = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(".el-form-item__error, .formError, .el-message, [class*='error']"))) {
      const t = (el.textContent || "").trim();
      if (t && t.length < 200 && el.getBoundingClientRect().width > 0) out.push(t);
    }
    return Array.from(new Set(out));
  });
  if (hints.length) hints.forEach((h) => log("  · " + h));
  else log("  （页面上没有可见的错误提示）");

  await page.screenshot({ path: join(OUT, "provider-models-error.png") });
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync(join(OUT, "provider-models-probe.log"), lines.join("\n") + "\n", "utf-8");
  await browser.close();
}