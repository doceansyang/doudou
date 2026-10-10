/**
 * 验证：文档面板的文件树是否已隐藏「工作区根目录下的系统项」。
 *
 * 判据按层级来（树的每行带 aria-level）：
 *   · 根（level=1) 不应再出现 assets / 画布*.json / *.bak
 *   · 用户自己的文件夹（如 myProject）应保留；其内部的 assets/generated 属于用户内容，保留
 *
 * 注意：不能用「文本里有没有 assets」来判断 —— 用户自己的项目夹里也可能有 assets 子目录。
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000);
await page.getByText("文档", { exact: true }).first().click().catch(() => {});
await page.waitForTimeout(6000);

const rows = await page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>(".treeRow")).map((el) => ({
    level: Number(el.getAttribute("aria-level") || "0"),
    label: (el.getAttribute("aria-label") || el.innerText || "").trim(),
  })),
);

const roots = rows.filter((r) => r.level === 1);
console.log("根目录实际显示（level=1）:");
for (const r of roots) console.log(`   · ${r.label}`);
console.log();

const bad = roots.filter((r) => r.label === "assets" || /^画布.*\.json$/i.test(r.label) || /\.(bak|orig|tmp|log)$/i.test(r.label));
console.log("=== 系统项检查（根目录）===");
if (!bad.length) {
  console.log("  ✓ 已全部隐藏：assets / 画布*.json / *.bak 都不在根目录出现");
} else {
  for (const r of bad) console.log(`  ❌ 仍显示：${r.label}`);
}
console.log();
console.log("=== 用户内容 ===");
console.log(`  ${roots.some((r) => r.label === "myProject") ? "✓ 保留" : "（无 myProject，可忽略）"}  myProject`);

await page.screenshot({ path: "assets/_doc-tree.png" });
console.log("\n截图: toonflow/assets/_doc-tree.png");
await browser.close();
process.exit(bad.length ? 1 : 0);
