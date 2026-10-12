import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：文本模型的「编辑供应商」弹窗是不是只剩一个填 Key 的地方。
//
// 期望：
//   A. 编辑官方 Linke（id=JinyuDream，地址=api.linke.link）
//      → 不出现 Provider ID / 显示名称 / API 地址 / API 协议；
//        有 说明（含「注册链接」）+ API 密钥 + 模型列表。
//   B. 添加自定义供应商（不锁定）
//      → 四个字段照旧都在（别把「加自己的中转站」这条路也堵了）。
//
// 判据：读渲染出来的 el-form-item 标签文案（看得见才算数），不看源码。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
await page.locator(".projectEntry").first().click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.waitForTimeout(1800);
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(900);

async function clickNav(text) {
  const pos = await page.evaluate((t) => {
    const cands = [];
    document.querySelectorAll("*").forEach((el) => {
      if ((el.textContent || "").trim() !== t) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      let d = 0; for (let q = el; q; q = q.parentElement) d += 1;
      cands.push({ d, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    cands.sort((a, b) => b.d - a.d);
    return cands[0] || null;
  }, text);
  if (!pos) throw new Error("找不到导航项：" + text);
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(800);
}

// 读当前可见弹窗里的：标题 / 表单标签 / 是否有说明与注册链接 / 模型列表标题
async function readDialog() {
  return page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll(".el-dialog"))
      .filter((el) => el.getBoundingClientRect().width > 0).pop();
    if (!dialog) return null;
    const title = (dialog.querySelector(".el-dialog__header")?.innerText || "").trim();
    const labels = Array.from(dialog.querySelectorAll(".el-form-item__label"))
      .map((el) => (el.textContent || "").trim()).filter(Boolean);
    const readme = dialog.querySelector(".providerReadme");
    return {
      title,
      labels,
      hasReadme: !!readme && !!(readme.innerText || "").trim(),
      readmeText: readme ? (readme.innerText || "").replace(/\s+/g, " ").trim() : "",
      hasModelList: /模型列表/.test(dialog.innerText || ""),
      hasFetch: /获取模型列表/.test(dialog.innerText || ""),
    };
  });
}

const FIELDS = ["Provider ID", "显示名称", "API 地址", "API 协议"];
const result = {};

console.log("=== A. 文本模型 → 编辑官方 Linke ===");
await clickNav("文本模型");
const card = page.locator(".providerList .providerItem").filter({ hasText: /Linke/ }).first();
await card.waitFor({ state: "visible", timeout: 20000 });
await card.locator('button:has-text("编辑")').first().click();
await page.locator(".el-dialog:visible").first().waitFor({ state: "visible", timeout: 15000 });
await page.waitForTimeout(700);
result.official = await readDialog();
await page.screenshot({ path: join(outDir, "_text-provider-official.png"), clip: await page.locator(".el-dialog:visible").first().boundingBox() });
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

console.log("=== B. 文本模型 → 添加自定义供应商（不锁定）===");
await page.locator('button:has-text("添加自定义供应商")').first().click();
await page.locator(".el-dialog:visible").first().waitFor({ state: "visible", timeout: 15000 });
await page.waitForTimeout(700);
result.custom = await readDialog();
await page.screenshot({ path: join(outDir, "_text-provider-custom.png"), clip: await page.locator(".el-dialog:visible").first().boundingBox() });
await page.keyboard.press("Escape");

function report(name, d) {
  const missing = FIELDS.filter((f) => !d.labels.includes(f));
  const present = FIELDS.filter((f) => d.labels.includes(f));
  console.log(`\n[${name}] 标题: ${d.title}`);
  console.log(`  表单标签: ${JSON.stringify(d.labels)}`);
  console.log(`  被藏掉的字段: ${JSON.stringify(missing)}   仍然出现的: ${JSON.stringify(present)}`);
  console.log(`  有说明=${d.hasReadme}  含「注册链接」=${/注册链接/.test(d.readmeText)}  有模型列表=${d.hasModelList}  有「获取模型列表」=${d.hasFetch}`);
  console.log(`  说明文案: ${d.readmeText.slice(0, 140)}`);
  return { missing, present };
}

const a = report("官方 Linke", result.official);
const b = report("自定义供应商", result.custom);

console.log("\n=== 判定 ===");
const aOk = a.missing.length === FIELDS.length && a.present.length === 0;
const aHasKey = result.official.labels.includes("API 密钥");
console.log(`  官方 Linke：四个身份字段全部收起 = ${aOk ? "✅" : "✗"}；只留 API 密钥 = ${aHasKey ? "✅" : "✗"}；有说明+注册链接 = ${result.official.hasReadme && /注册链接/.test(result.official.readmeText) ? "✅" : "✗"}；模型列表保留 = ${result.official.hasModelList ? "✅" : "✗"}`);
const bOk = b.present.length === FIELDS.length;
console.log(`  自定义供应商：四个字段照旧都在 = ${bOk ? "✅（没误伤）" : "✗"}`);

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
