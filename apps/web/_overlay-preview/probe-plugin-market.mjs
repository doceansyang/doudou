import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：设置 → 插件市场 恢复成 **Toonflow 后端**（api.toonflow.net）之后的实况。
//
// 背景：品牌替换脚本把全仓的 api.toonflow.net 一律换成了 api.linke.link，但插件市场那套
// `/v1/plugin/*` 是 Toonflow 后台的私有路由，linke 上实测 404「Invalid URL」，面板就一直报
// 「加载插件市场失败」。这里验四件事：
//   ① 面板不再出现「加载插件市场失败」；
//   ② 「网页版市场」的链接指向 toonflow；
//   ③ 请求**真的**发往 api.toonflow.net（临时塞一把 key 触发一次真实请求，事后清掉）；
//   ④ 那把 key **只写进市场自己的字段**，绝不能覆盖 Linke 供应商的 key（历史实现就会覆盖）。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// 记录应用发出的、与插件市场有关的请求（判"到底发去了哪个域"）。
const marketRequests = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/v1/plugin/")) marketRequests.push({ url, method: req.method() });
});

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });

const HEADERS = { "x-toonflow-workspace": "1" };
/** 读设置（要带 x-toonflow-workspace，否则 data 是 null）。 */
const readSettings = () => page.evaluate(async (headers) => {
  const { data } = await (await fetch("/api/settings/get", { headers })).json();
  return data;
}, HEADERS);
/** 写设置（整体覆盖式，所以要在读到的整份上打补丁）。 */
const writeSettings = (settings) => page.evaluate(async ({ headers, body }) => {
  const res = await fetch("/api/settings/save", {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ settings: body }),
  });
  return (await res.json()).code;
}, { headers: HEADERS, body: settings });

const before = await readSettings();
const linkeKeyBefore = before?.customProviders?.find((p) => String(p.id).toLowerCase() === "jinyudream")?.apiKey ?? "";
console.log(`初始：pluginMarketApiKey = ${JSON.stringify(before?.pluginMarketApiKey)}；Linke key = ${linkeKeyBefore ? linkeKeyBefore.slice(0, 8) + "…" : "(空)"}`);

let failures = 0;
try {
  // ③ 临时塞一把 key（用 Linke 那把即可 —— 一定会在 toonflow 上 401，正好验证"发往哪个域"）。
  if (linkeKeyBefore) {
    await writeSettings({ ...before, pluginMarketApiKey: linkeKeyBefore });
    // ⚠️ 必须 `goto` 根路径做整文档重载（设置 store 只在启动时 loadSettings 一次，不重载看不到新 key）。
    //    不能用 `reload()` —— 此刻页面已经在**工作区路由**上，reload 会停在同一个路由，
    //    首页的 `.projectEntry` 永远不出现（踩过：探针静默超时 20s）。
    await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
    await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 20000 });
    await page.locator(".projectEntry").first().click();
    await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
  }

  await page.locator('button[aria-label="设置"]').first().click();
  await page.waitForTimeout(1000);
  const nav = await page.evaluate(() => {
    const cands = [];
    document.querySelectorAll("*").forEach((el) => {
      if ((el.textContent || "").trim() !== "插件市场") return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      let depth = 0;
      for (let q = el; q; q = q.parentElement) depth += 1;
      cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    cands.sort((a, b) => b.depth - a.depth);
    return cands[0] || null;
  });
  if (!nav) throw new Error("设置面板里没找到「插件市场」");
  await page.mouse.click(nav.x, nav.y);
  await page.waitForTimeout(4000);   // 等市场请求跑完

  const text = await page.locator(".pluginMarket").first().innerText();
  const hosts = [...new Set(marketRequests.map((r) => new URL(r.url).host))];

  const noError = !text.includes("加载插件市场失败");
  // ② 两个"上哪儿找插件"的入口已整体删除（它们指向 Toonflow 的控制台/文档，会把字样递给用户）。
  const buttonsGone = !text.includes("网页版市场") && !text.includes("开发者文档");
  console.log(`\n面板文字（前 120 字）：${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 120))}`);
  console.log(`① 不再出现「加载插件市场失败」：${noError ? "✓" : "✗"}`);
  console.log(`② 「网页版市场 / 开发者文档」已移除：${buttonsGone ? "✓" : "✗"}`);
  console.log(`③ 应用发出的 /v1/plugin/* 请求：${marketRequests.length} 次，域名 ${JSON.stringify(hosts)}：${hosts.length && hosts.every((h) => h === "api.toonflow.net") ? "✓ 发往 toonflow" : "✗"}`);
  if (!noError) failures++;
  if (!buttonsGone) failures++;
  if (!hosts.length || !hosts.every((h) => h === "api.toonflow.net")) failures++;

  await page.screenshot({ path: join(outDir, "settings-plugin-market.png") });
} catch (error) {
  // 不能静默吞异常 —— 否则探针"什么都没打印就结束"，看起来像通过。
  console.error("探针失败：" + (error instanceof Error ? error.message : String(error)));
  failures++;
} finally {
  // ④ 把 key **还原成探针运行前的原值**，并核对 Linke 的 key 没被动过。
  //    ⚠️ 这里曾经是无条件 `delete pluginMarketApiKey` —— 于是把**用户自己填的那把也删了**。
  //       探针只该动自己写进去的东西：原来有就还原成原值，原来没有才删。
  const after = await readSettings();
  const restored = { ...after };
  if (Object.hasOwn(before ?? {}, "pluginMarketApiKey")) restored.pluginMarketApiKey = before.pluginMarketApiKey;
  else delete restored.pluginMarketApiKey;
  await writeSettings(restored);
  const final = await readSettings();
  const linkeKeyAfter = final?.customProviders?.find((p) => String(p.id).toLowerCase() === "jinyudream")?.apiKey ?? "";
  const untouched = linkeKeyAfter === linkeKeyBefore;
  const keyRestored = final?.pluginMarketApiKey === before?.pluginMarketApiKey;
  console.log(`④ 市场 key 已还原成原值（${JSON.stringify(String(final?.pluginMarketApiKey ?? "").slice(0, 8))}…）：${keyRestored ? "✓" : "✗"}；Linke key 未被覆盖：${untouched ? "✓" : "✗"}`);
  if (!untouched || !keyRestored) failures++;
  console.log(`\n页面错误：${errors.length ? JSON.stringify(errors.slice(0, 3)) : "无"}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
