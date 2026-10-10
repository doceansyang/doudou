/** 验证：设置 → 文本模型 里的官方供应商是否已切到 Linke / api.linke.link。 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  await page.locator('button[title^="设置"]').first().click();
  await page.waitForSelector(".settingsItem", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator(".settingsItem").filter({ hasText: "文本模型" }).first().click();
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const card = document.querySelector(".providerItem");
    const text = card ? (card.textContent || "").replace(/\s+/g, " ").trim() : "";
    const links = Array.from(document.querySelectorAll(".providerItem a")).map((a) => ({
      text: (a.textContent || "").trim(),
      href: a.getAttribute("href"),
    }));
    return {
      name: (card?.querySelector(".providerName")?.textContent || "").trim(),
      providerId: (card?.querySelector(".providerId")?.textContent || "").trim(),
      tags: Array.from(card?.querySelectorAll(".el-tag") || []).map((t) => (t.textContent || "").trim()),
      links,
      hasOldBrand: /TF-Router|TF-router|toonflow\.net/i.test(text),
      snippet: text.slice(0, 130),
    };
  });

  log(`供应商名称: ${info.name}`);
  log(`内部 id    : ${info.providerId}`);
  log(`标签       : ${info.tags.join(" / ")}`);
  log("链接:");
  info.links.forEach((l) => log(`   「${l.text}」 -> ${l.href}`));
  log("");
  log(`卡片文本: ${info.snippet}`);
  log("");
  log(`旧品牌残留(TF-Router / toonflow.net): ${info.hasOldBrand ? "❌ 仍有残留" : "✓ 已清除"}`);

  await page.screenshot({ path: "assets/_linke-switch.png" });
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_linke-switch.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
