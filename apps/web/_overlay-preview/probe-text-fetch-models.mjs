import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：设置 → 文本模型 的「获取模型」按钮。
//
// 两条判据（都是用户这次提的）：
//   ① 按钮**常驻**在最右侧那一排（与媒体模型那侧对齐），不再只在"模型列表为空"时出现；
//   ② 点它拿到的**只有文本模型** —— 网关 /v1/models 是文本 + 图片 + 视频混在一起的全量列表。
//
// ⚠️ 这里**只读取**接口返回，不点按钮 —— 点了会把结果写回 settings.customProviders，
//    那是用户的数据，验证不该改它。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(1200);

const hit = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll("*").forEach((el) => {
    if ((el.textContent || "").trim() !== "文本模型") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let depth = 0;
    for (let q = el; q; q = q.parentElement) depth += 1;
    cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  });
  cands.sort((a, b) => b.depth - a.depth);
  return cands[0] || null;
});
if (!hit) throw new Error("设置面板里没找到「文本模型」");
await page.mouse.click(hit.x, hit.y);
await page.waitForTimeout(1500);

// ① 按钮是否常驻在卡片右侧的操作排里
const actions = await page.locator(".providerItem .itemActions button").allInnerTexts();
const fetchBtn = page.locator(".providerItem .itemActions button", { hasText: "获取模型" });
const fetchCount = await fetchBtn.count();
const mediaCount = await page.locator(".providerItem", { hasText: "个模型" }).count();
const modelLabel = await page.locator(".providerItem .providerMeta").first().innerText().catch(() => "");
const footer = await page.locator(".providerActions").count();
console.log("=== 设置 → 文本模型 ===");
console.log(`  卡片操作排：${JSON.stringify(actions.map((t) => t.trim()))}`);
console.log(`  卡片上已配置的模型数文案：${JSON.stringify(modelLabel.trim())}`);
console.log(`  「获取模型」按钮数：${fetchCount}（应为 1）`);
console.log(`  底部「添加供应商」区块：${footer}（应为 0）`);
console.log(`  结论①：${fetchCount === 1 && footer === 0 ? "✓ 常驻且添加入口已下线" : "✗"}`);
await page.screenshot({ path: join(outDir, "settings-text-fetch-models.png") });

// ② 接口返回的是不是只有文本模型（读取 settings 里存的那把 key，不写入）
const check = await page.evaluate(async () => {
  // ⚠️ `/api/settings/get` 要带 `x-toonflow-workspace: 1`（前端 store 就是这么调的）；
  //    少了这个头会返回 `data: null`，读 `data.customProviders` 直接炸 —— 别误判成"设置空了"。
  const { data } = await (await fetch("/api/settings/get", { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } })).json();
  const provider = (data?.customProviders || []).find((p) => String(p.id).toLowerCase() === "jinyudream");
  if (!provider) return { error: "settings 里没有找到 JinyuDream 文本供应商" };
  const res = await fetch("/api/providers/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiUrl: provider.apiUrl, protocol: provider.protocol, apiKey: provider.apiKey }),
  });
  const body = await res.json();
  return { http: res.status, code: body.code, ids: (body.data || []).map((m) => m.id), message: body.message };
});
console.log("\n=== POST /api/providers/models（默认 kind=language）===");
if (check.error) console.log("  " + check.error);
else {
  console.log(`  HTTP ${check.http} code=${check.code} 返回 ${check.ids.length} 个：${JSON.stringify(check.ids)}`);
  const mediaPattern = /seedance|wan3|grok-video|gpt-image|doubao/i;
  const leaked = check.ids.filter((id) => mediaPattern.test(id));
  console.log(`  混进媒体模型的：${JSON.stringify(leaked)}（应为空）`);
  console.log(`  结论②：${leaked.length === 0 && check.ids.length > 0 ? "✓ 只有文本模型" : "✗"}`);
}
console.log(`\n页面错误：${errors.length ? JSON.stringify(errors.slice(0, 3)) : "无"}`);
await browser.close();
