/**
 * 验证「关于」页不再弹红色错误条，且媒体模型里的官方供应商标识恢复正常。
 * 跑法：cd toonflow && bun scripts/_verify-about.ts
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1200);

  // ① 关于页：不应该出现错误提示条
  await page.locator(".settingsItem").filter({ hasText: "关于" }).first().click();
  await page.waitForTimeout(5000);
  const errs = await page.locator(".el-message--error").count();
  const errText = errs ? await page.locator(".el-message--error").first().innerText().catch(() => "") : "";
  log(`关于页：错误提示条 ${errs} 个${errText ? "（内容：" + errText.trim() + "）" : ""} ${errs === 0 ? "✓" : "✗"}`);
  await page.screenshot({ path: "assets/_verify-about.png" });

  // ② 媒体模型：官方供应商应有「官方」标签与 logo
  await page.locator(".settingsItem").filter({ hasText: "媒体模型" }).first().click();
  await page.waitForTimeout(2500);
  const tags = await page.locator(".providerList .el-tag").allInnerTexts().catch(() => []);
  const logos = await page.locator(".providerList .providerLogo").count();
  log(`媒体模型：provider 卡片 ${await page.locator(".providerList .providerItem").count()} 个，`
    + `「官方」标签 ${tags.filter((t) => t.includes("官方")).length} 个，logo ${logos} 个`);
  await page.screenshot({ path: "assets/_verify-media.png" });

  // ③ 文本模型同样检查一眼
  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(2000);
  log(`文本模型：「官方」标签 ${(await page.locator(".providerList .el-tag").allInnerTexts().catch(() => [])).filter((t) => t.includes("官方")).length} 个`);
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_verify-about.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
