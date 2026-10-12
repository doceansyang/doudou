// 拦截视频生成节点发出的真实请求，确认「参考图 / 参考视频 / 参考音频」有没有被带上。
// ⚠️ 生成请求**不放行**（既不 fulfill 也不 continue），所以不会真的出网、不会花钱。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
await page.locator(".projectEntry").first().waitFor({ state: "visible", timeout: 25000 });
await page.locator(".projectEntry").first().click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 35000 });
await page.waitForTimeout(2000);

// ── ① 诊断：列出画布上每个节点的 data-id / 可见文本 ──
const nodes = await page.evaluate(() =>
  [...document.querySelectorAll(".vue-flow__node")].map((el, i) => ({
    i,
    id: el.getAttribute("data-id") || "",
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 55),
  })),
);
console.log("=== 画布节点 ===");
for (const n of nodes) console.log(`  [${String(n.i).padStart(2)}] ${n.id.slice(0, 8)}  ${n.text}`);

// 目标：a658546f（挂了 3 张参考图的 wan3.0 视频节点）
const target = nodes.find((n) => n.id.startsWith("a658546f")) ?? nodes.find((n) => /视频生成/.test(n.text));
if (!target) {
  console.log("\n⚠️ 没找到视频生成节点");
  await browser.close();
  process.exit(1);
}
console.log(`\n选中节点 [${target.i}] ${target.id.slice(0, 8)}：${target.text}`);

// ── ② 挂请求拦截：把生成请求扣住 ──
const captured = [];
await page.route("**/api/ai/media/generate", async (route) => {
  try {
    captured.push(JSON.parse(route.request().postData() || "{}"));
  } catch (error) {
    captured.push({ __parseError: String(error) });
  }
  // 故意不回复：让节点停在「生成中」，请求不出网
});

// ── ③ 选中节点（节点只有选中时才渲染底栏，底栏里才有参考图与生成按钮）──
const node = page.locator(`[data-id="${target.id}"]`);
const box = await node.boundingBox();
await page.mouse.click(box.x + 26, box.y + 14);
await page.waitForTimeout(1800);

const panel = await page.evaluate((id) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return null;
  const thumbs = [...el.querySelectorAll("img")].filter((im) => im.naturalWidth > 0);
  return {
    thumbs: thumbs.map((im) => (im.src || "").slice(0, 60)),
    buttons: [...el.querySelectorAll("[aria-label]")].map((b) => b.getAttribute("aria-label")).filter(Boolean),
    model: (el.querySelector('[aria-label="生成模型"]')?.textContent || "").trim(),
  };
}, target.id);
console.log("\n=== 选中后的底栏 ===");
console.log("  参考图缩略图:", panel?.thumbs.length, JSON.stringify(panel?.thumbs.slice(0, 4)));
console.log("  按钮:", JSON.stringify(panel?.buttons));
console.log("  模型:", panel?.model);
await node.screenshot({ path: join(outDir, "_video-refs-node.png") }).catch(() => {});

// ── ④ 点生成，读被扣住的请求体 ──
// ⚠️ 不能用 locator.click()：节点常有一半在视口外，Playwright 会报
//    "Element is outside of the viewport"。直接在页面里派发 click 最稳。
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[aria-label="生成视频"]')];
  const btn = btns.find((b) => !b.disabled && b.getBoundingClientRect().width > 0) ?? btns[0];
  if (!btn) return "没找到按钮";
  if (btn.disabled) return "按钮被禁用";
  btn.click();
  return "已点击（共 " + btns.length + " 个匹配）";
});
console.log("\n点击生成:", clicked);
await page.waitForTimeout(3000);

console.log("\n=== 捕获到的生成请求 ===");
if (!captured.length) console.log("  （没有捕获到请求）");
for (const body of captured) {
  const shown = { ...body };
  for (const key of ["images", "videos", "audios"]) {
    if (Array.isArray(shown[key])) {
      shown[key] = shown[key].map((it) => ({ ...it, path: String(it.path || "").slice(0, 70) }));
    }
  }
  if (typeof shown.prompt === "string") shown.prompt = shown.prompt.slice(0, 260);
  console.log(JSON.stringify(shown, null, 1));
}

await page.waitForTimeout(1200);
await page.screenshot({ path: join(outDir, "_video-refs-canvas.png") }).catch(() => {});
console.log("\n页面错误:", errors.length ? errors.join(" | ") : "（无）");
await browser.close();
