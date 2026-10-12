// 检查画布上有没有**注册失败的节点**（表现为节点变成一块写着 error 的卡片）。
// 这类故障在控制台里只留一行 "远程节点 remote-xxx 运行失败"，很容易被忽略，
// 而用户看到的是"这个节点坏了"。典型成因：节点的 zod schema 里塞进了非静态值
// （例如把 `z.enum(computed)` 这种 —— `z.toJSONSchema()` 会抛
// "Error converting schema to JSON."，整块节点挂掉）。
//
// 用法：node probe-node-errors.mjs      （需要应用在跑）
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const bad = [];
const nodeErrors = [];
page.on("response", (r) => { if (r.status() >= 400 && !/favicon/i.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && /节点|schema|register/i.test(t)) nodeErrors.push(t.split("\n")[0].slice(0, 240));
});
page.on("pageerror", (e) => nodeErrors.push("pageerror: " + e.message.slice(0, 200)));

for (let attempt = 1; ; attempt++) {
  try { await page.goto("http://127.0.0.1:3000/", { waitUntil: "load", timeout: 30000 }); break; }
  catch (e) { if (attempt >= 6) throw e; await page.waitForTimeout(3000); }
}
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
if (await entry.count()) await entry.click().catch(() => {});
await page.waitForFunction(() => document.querySelectorAll(".vue-flow__node").length > 0, null, { timeout: 60000 });
await page.waitForTimeout(5000);

const dom = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll(".vue-flow__node"));
  return {
    total: nodes.length,
    // 注册失败的节点会把错误文案直接渲染在卡片里
    errored: nodes.filter((n) => /schema|Error|错误/i.test(n.innerText || "")).map((n) => (n.innerText || "").replace(/\s+/g, " ").slice(0, 80)),
    titles: nodes.map((n) => (n.innerText || "").split("\n")[0].slice(0, 20)),
  };
});
console.log("画布节点数:", dom.total);
console.log("  标题:", JSON.stringify(dom.titles));
console.log("  注册失败的节点:", dom.errored.length ? JSON.stringify(dom.errored) : "无 ✅");
console.log("  4xx/5xx:", bad.length ? [...new Set(bad)].join(" | ") : "（无）");
console.log("  节点错误:", nodeErrors.length ? nodeErrors.join(" || ") : "（无）✅");
await browser.close();
process.exit(dom.errored.length || nodeErrors.length ? 1 : 0);
