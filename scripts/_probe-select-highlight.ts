/**
 * 验证：模型下拉里「当前选中项」是否明显高亮（深色模式下也要看得清）。
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const VIEW = { width: 1600, height: 950 };
const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => log(`  [pageerror] ${e.message.slice(0, 160)}`));

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  // 选中一个节点，让它的模型选择器（在 bottom 槽）出现
  const nodes = page.locator(".vue-flow__node");
  const total = await nodes.count();
  const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
  let idx = -1, box = null;
  for (let i = 0; i < total; i++) {
    const b = await nodes.nth(i).boundingBox();
    if (inside(b) && b.width > 150) { idx = i; box = b; break; }
  }
  log(`测试节点: #${idx}`);
  for (const [dx, dy] of [[0.08, 0.07], [0.5, 0.1], [0.5, 0.5]]) {
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await page.waitForTimeout(900);
    if (await page.locator(".vue-flow__node.selected").count() > 0) break;
  }

  // 打开模型下拉
  const select = page.locator(".el-select").filter({ has: page.locator("input") }).first();
  const count = await page.locator(".el-select").count();
  log(`页面上 .el-select 数量: ${count}`);
  await page.locator(".el-select").first().click();
  await page.waitForTimeout(1800);

  const items = await page.locator(".el-select-dropdown__item").count();
  log(`下拉选项数量: ${items}`);

  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".el-select-dropdown__item"));
    const selected = rows.filter((el) => el.classList.contains("is-selected"));
    const lum = (rgb) => {
      const m = rgb.match(/\d+/g);
      if (!m) return null;
      const [r, g, b] = m.slice(0, 3).map(Number);
      return +(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(1);
    };
    return {
      total: rows.length,
      selectedCount: selected.length,
      samples: selected.slice(0, 2).map((el) => {
        const cs = getComputedStyle(el);
        return {
          text: (el.textContent || "").trim().slice(0, 24),
          color: cs.color, background: cs.backgroundColor, weight: cs.fontWeight,
          contrast: (lum(cs.color) !== null && lum(cs.backgroundColor) !== null)
            ? Math.abs(lum(cs.color) - lum(cs.backgroundColor)).toFixed(1) : "?",
        };
      }),
      // 顺便看看未选中项做对比
      normal: rows.length ? (() => {
        const el = rows.find((e) => !e.classList.contains("is-selected")) || rows[0];
        const cs = getComputedStyle(el);
        return { text: (el.textContent || "").trim().slice(0, 24), color: cs.color, background: cs.backgroundColor };
      })() : null,
    };
  });

  log("");
  log("=== 选中项样式 ===");
  log(`  is-selected 命中: ${info.selectedCount} 项`);
  info.samples.forEach((s) => {
    log(`  「${s.text}」`);
    log(`     文字色=${s.color}  底色=${s.background}  字重=${s.weight}`);
    log(`     明暗差=${s.contrast}（越大越清晰）`);
  });
  log("");
  log("=== 未选中项（对照）===");
  log(`  「${info.normal?.text}」 文字色=${info.normal?.color} 底色=${info.normal?.background}`);

  // 把选中项滚进视野后，只截下拉面板本身，便于直观对比
  await page.locator(".el-select-dropdown__item.is-selected").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator(".el-select-dropdown").last().screenshot({ path: "assets/_select-highlight.png" }).catch(async () => {
    await page.screenshot({ path: "assets/_select-highlight.png" });
  });
  log("");
  log(`结论: ${Number(info.samples[0]?.contrast ?? 0) > 60 ? "✓ 选中项已明显高亮" : "❌ 对比度仍然不足"}`);
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_select-highlight.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
