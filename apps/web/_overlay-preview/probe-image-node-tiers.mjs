import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：图片节点的「档位 → 比例」是否按模型声明联动。
//
// 背景：gpt-image-2 的 1K / 2K 支持 13 种比例，**4K 只支持 8 种**
// （不含 1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 5:4 / 4:5）。节点必须按当前档位过滤比例按钮，
// 否则用户会在 4K 下选到上游会拒的比例。
//
// 判据：数渲染出来的比例按钮（读 DOM），不看源码。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const closeBtn = page.locator('[aria-label="关闭对话"]').first();
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(600); }
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click().catch(() => {}); await page.waitForTimeout(1200); }

// 选中「图片生成」节点（底栏只在选中时存在）
const node = page.locator(".vue-flow__node").filter({ hasText: /图片生成/ }).first();
console.log("图片生成节点数:", await page.locator(".vue-flow__node").filter({ hasText: /图片生成/ }).count());
const box = await node.boundingBox();
await page.mouse.click(box.x + 24, box.y + 12);
await page.waitForTimeout(1500);

// 打开生成设置
await node.locator('[aria-label="图片生成设置"]').first().click();
await page.waitForTimeout(900);

async function read() {
  // ⚠️ 档位用的是 `el-radio-button`（不是 `el-radio`）—— 别按 .el-radio 找，会一个都找不到。
  //    另外弹层不一定是「最后一个 popper」（页面上还有 tooltip），所以直接按 aria-label 定位。
  return page.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const sizeGroups = Array.from(document.querySelectorAll('[aria-label="图片分辨率"]')).filter(vis);
    const ratioGroups = Array.from(document.querySelectorAll('[aria-label="图片比例"]')).filter(vis);
    return {
      sizes: sizeGroups.length
        ? Array.from(sizeGroups[0].querySelectorAll(".el-radio-button__inner")).filter(vis).map((el) => (el.textContent || "").trim())
        : [],
      ratios: ratioGroups.length
        ? Array.from(ratioGroups[0].querySelectorAll("button")).filter(vis).map((el) => (el.textContent || "").trim()).filter(Boolean)
        : [],
    };
  });
}

async function pickSize(label) {
  const hit = await page.evaluate((lab) => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    for (const group of Array.from(document.querySelectorAll('[aria-label="图片分辨率"]')).filter(vis)) {
      for (const el of group.querySelectorAll(".el-radio-button")) {
        const text = (el.querySelector(".el-radio-button__inner")?.textContent || el.textContent || "").trim();
        if (text === lab && vis(el)) {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
    }
    return null;
  }, label);
  if (!hit) return false;
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(700);
  return true;
}

const out = {};
for (const tier of ["1K", "2K", "4K"]) {
  if (!(await pickSize(tier))) { console.log(`  ⚠️ 找不到档位 ${tier}`); continue; }
  const d = await read();
  out[tier] = d;
  console.log(`  ${tier}: 档位按钮=${JSON.stringify(d.sizes)}  比例 ${d.ratios.length} 种 → ${d.ratios.join(" ")}`);
}
await page.screenshot({ path: join(outDir, "_image-node-tiers.png") });

console.log("\n=== 判定 ===");
const c = (t) => out[t]?.ratios.length ?? -1;
console.log(`  1K 支持 13 种比例 = ${c("1K") === 13 ? "✅" : "✗ (" + c("1K") + ")"}`);
console.log(`  2K 支持 13 种比例 = ${c("2K") === 13 ? "✅" : "✗ (" + c("2K") + ")"}`);
console.log(`  4K 支持 8 种比例  = ${c("4K") === 8 ? "✅" : "✗ (" + c("4K") + ")"}`);
// 4K 相对 1K/2K 少掉的是这 5 种（4:3 / 3:4 在 4K 里**是支持的**，别把它们算进来）
const dropped = ["1:1", "3:2", "2:3", "5:4", "4:5"];
console.log(`  4K 去掉了 ${dropped.join("/")} = ${dropped.every((r) => !out["4K"]?.ratios.includes(r)) ? "✅" : "✗"}`);
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
