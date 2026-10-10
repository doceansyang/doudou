/**
 * 「关于」页 + 检查更新回归
 *
 * 用户 2026-10-10 要求：更新源只保留我们自己的 GitHub 仓库，去掉「官方源」。
 * 这条探针验证三件事：
 *   ① 关于页**不再有更新源下拉框**（官方源 / 自定义源都应消失）
 *   ② 页面上有一个静态的来源标签，指向 JinyuTV 官方仓库
 *   ③ 点「检查更新」真的能联到 GitHub Releases 并比对出结果
 *      （本机是 2.0.0，仓库最新是 2.0.1 → 应提示发现新版本）
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => log(`  [pageerror] ${String(e.message).split("\n")[0]}`));

try {
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.locator('button[aria-label="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator(".settingsItem").filter({ hasText: "关于" }).first().click();
  await page.waitForTimeout(2000);

  // ① 下拉框是否已移除
  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".el-select")).map((s) => (s.textContent || "").trim()),
  );
  const hasSourceSelect = selects.some((t) => /官方源|GitHub|自定义源/.test(t));
  log(`① 更新源下拉框：${hasSourceSelect ? "!! 仍存在" : "已移除 ✓"}`);
  if (selects.length) log(`   页面上的下拉框内容：${JSON.stringify(selects)}`);

  // ② 静态来源标签
  const tag = await page.evaluate(() => {
    const el = document.querySelector(".updateSourceTag");
    return el ? { text: (el.textContent || "").trim(), label: el.getAttribute("aria-label") } : null;
  });
  log(`② 来源标签：${tag ? `「${tag.text}」 aria-label=${tag.label}` : "!! 没找到"}`);

  // 版本号
  const version = await page.evaluate(() => {
    const m = (document.body.textContent || "").match(/v\d+\.\d+\.\d+/);
    return m ? m[0] : "";
  });
  log(`   当前版本显示：${version}`);
  await page.screenshot({ path: join(OUT, "about-single-source.png") });

  // ③ 点「检查更新」
  log("");
  log("③ 点「检查更新」…");
  await page.locator(".el-dialog button, button").filter({ hasText: "检查更新" }).first().evaluate((b: HTMLButtonElement) => b.click());
  await page.waitForTimeout(14000);

  const result = await page.evaluate(() => {
    const text = document.body.textContent || "";
    const found = text.match(/发现新版本[\s\S]{0,120}/);
    const err = text.match(/无法获取更新信息[^。]{0,80}/);
    const buttons = Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean);
    return { found: found ? found[0].replace(/\s+/g, " ") : "", err: err ? err[0] : "", buttons: buttons.slice(0, 24) };
  });
  log(`   发现新版本提示：${result.found || "（无）"}`);
  log(`   错误提示      ：${result.err || "（无）"}`);
  log(`   页面按钮      ：${JSON.stringify(result.buttons)}`);
  await page.screenshot({ path: join(OUT, "about-update-checked.png") });
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync(join(OUT, "about-source-probe.log"), lines.join("\n") + "\n", "utf-8");
  await browser.close();
}