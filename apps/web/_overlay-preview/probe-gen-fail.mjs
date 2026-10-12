// 复现「生成失败」并读出**真实报错文案**。
//
// ⚠️ 关键设计：把 `/api/ai/media/generate` 在浏览器侧**拦掉**（route.abort），
//    这样即使节点的校验通过、请求发出去了，服务端也不会真的去网关下单 ——
//    不会产生任何费用。而如果失败发生在**客户端校验**（节点自身 throw），
//    照样能读到那条真实文案。
//    同时记录"请求有没有发出去"，用来区分「客户端校验失败」和「下游/网关失败」。
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
let generateRequested = null;
await page.route("**/api/ai/media/generate", (route) => {
  generateRequested = route.request().postData()?.slice(0, 600) ?? "(无 body)";
  return route.abort();
});

for (let attempt = 1; ; attempt++) {
  try { await page.goto("http://127.0.0.1:3000/", { waitUntil: "load", timeout: 30000 }); break; }
  catch (e) { if (attempt >= 6) throw e; await page.waitForTimeout(3000); }
}
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
if (await entry.count()) await entry.click().catch(() => {});
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(3500);

const closeBtn = page.locator('[aria-label="关闭对话"]').first();
await closeBtn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(800); }
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click().catch(() => {}); await page.waitForTimeout(1500); }

// 逐个选中视频生成节点，读出它当前选的模型；找到用 Linke Mini 的那个
const nodes = page.locator(".vue-flow__node").filter({ hasText: /视频生成/ });
const total = await nodes.count();
console.log("视频生成节点数:", total);
let target = null;
for (let i = 0; i < total; i++) {
  const n = nodes.nth(i);
  const box = await n.boundingBox();
  if (!box) continue;
  await page.mouse.click(box.x + 24, box.y + 12);
  await page.waitForTimeout(1200);
  const info = await n.evaluate((el) => {
    const sel = el.querySelector(".modelSelect");
    const btn = el.querySelector('[aria-label="视频生成设置"]');
    const text = (sel?.innerText || sel?.textContent || "").trim();
    const refs = el.querySelectorAll(".referenceItem, .refItem, [class*='reference']").length;
    return { model: text, hasSettings: !!btn, refs, bodyText: (el.innerText || "").replace(/\s+/g, " ").slice(0, 160) };
  });
  console.log(`  #${i + 1} 模型=${JSON.stringify(info.model)} 底栏=${info.hasSettings} 卡片文案=${info.bodyText.slice(0, 90)}`);
  if (/mini/i.test(info.model) && /linke|seedance/i.test(info.model)) { target = { i, n }; }
}
if (!target) {
  console.log("\n没找到 Linke Mini 的节点。改用第一个视频生成节点试。");
  const n0 = nodes.nth(0);
  const box = await n0.boundingBox();
  await page.mouse.click(box.x + 24, box.y + 12);
  await page.waitForTimeout(1200);
  target = { i: 0, n: n0 };
}

// 点生成（拦截器保证不会真的下单）
// ⚠️ 用 aria-label 定位：`.sendButton` 这个 class 在节点底栏里取不到（实测 count=0），
//    而模板上明明写着 class="sendButton" —— 按可见的 aria-label 找更稳。
// ⚠️ 必须**重新选中目标节点**：上面那个循环最后停在最后一个节点上，
//    而底栏只属于「当前选中」的那个 —— 不重选，量到的是别人的底栏（实测量到 1656,691 的视口外元素）。
{
  const b = await target.n.boundingBox();
  if (b) { await page.mouse.click(b.x + 24, b.y + 12); await page.waitForTimeout(1500); }
  const shown = await target.n.evaluate((el) => (el.querySelector(".modelSelect")?.innerText || "").trim());
  console.log("  重新选中目标节点，其模型显示 =", JSON.stringify(shown));
}

// 把所有可能的「生成」按钮连同位置都导出来 —— 页面上同时存在 Agent 面板的按钮，
// 只按 aria-label 取 first() 会点到别处（实测点到了 169x127 的另一个元素，中心还是 videoPlayer）。
const candidates = await page.evaluate(() => {
  const rows = [];
  const push = (kind, el) => {
    const r = el.getBoundingClientRect();
    rows.push({ kind, tag: el.tagName, aria: el.getAttribute("aria-label"), x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height), cls: (el.className || "").toString().slice(0, 50) });
  };
  document.querySelectorAll(".sendButton").forEach((el) => push("class:.sendButton", el));
  document.querySelectorAll('[aria-label="生成视频"], [aria-label="停止生成"]').forEach((el) => push("aria", el));
  return rows;
});
const nodeBox = await target.n.boundingBox();
console.log("\n=== 「生成」按钮候选 ===");
for (const c of candidates) console.log("  ", JSON.stringify(c));
console.log("  目标节点矩形:", nodeBox ? `${Math.round(nodeBox.x)},${Math.round(nodeBox.y)} ${Math.round(nodeBox.width)}x${Math.round(nodeBox.height)}` : "null");
// 落在节点矩形里的那个才是节点的发送按钮
const inNode = (c) => nodeBox && c.x >= nodeBox.x - 4 && c.y >= nodeBox.y - 4
  && c.x + c.w <= nodeBox.x + nodeBox.width + 4 && c.y + c.h <= nodeBox.y + nodeBox.height + 4;
const pick = candidates.find(inNode);
console.log("  选中:", pick ? JSON.stringify(pick) : "（节点内没有找到发送按钮！）");
if (pick) {
  const cx = pick.x + pick.w / 2, cy = pick.y + pick.h / 2;
  const topmost = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}.${(el.className || "").toString().slice(0, 40)}` : "null";
  }, [cx, cy]);
  console.log(`  该点最上层元素 = ${topmost}`);
  await page.mouse.click(cx, cy);
}
await page.waitForTimeout(5000);
const after = await target.n.evaluate((el) => ({
  overlay: !!el.querySelector(".genOverlay"),
  percent: (el.querySelector(".genPercent")?.textContent ?? "").trim(),
}));
console.log("  点击后：生成中遮罩=", after.overlay, " 百分比=", JSON.stringify(after.percent));

const notify = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll(".el-notification"));
  return items.map((el) => ({
    title: (el.querySelector(".el-notification__title")?.textContent ?? "").trim(),
    content: (el.querySelector(".el-notification__content")?.innerText ?? "").replace(/\s+/g, " ").trim(),
  }));
});
console.log("\n=== 页面上的错误通知 ===");
console.log(notify.length ? JSON.stringify(notify, null, 1) : "（无）");
console.log("\n=== 是否向服务端发起了生成请求 ===");
console.log(generateRequested ? "是 —— body: " + generateRequested : "否（失败发生在客户端校验，没到服务端）");

await page.screenshot({ path: "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow/scripts/_out/_gen-fail-repro.png" });
await browser.close();
