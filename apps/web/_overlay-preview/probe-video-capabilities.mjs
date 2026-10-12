import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：视频节点的「比例 / 时长 / 分辨率 / 模式」是否按**每个模型**的真实接口能力渲染。
//
// 期望值全部来自 toapis 官方文档（2026-10-12 核对）：
//   seedance-2      比例 7（含 adaptive）  时长 -1 与 4–15  分辨率 480p/720p/1080p/4k
//   seedance-2-mini 比例 7                 时长 4–15        分辨率 480p/720p
//   wan3.0-video    比例 6（含 adaptive）  时长 -1 与 2–30  分辨率 480p/720p/1080p
//   grok-video-1.5  比例 5                 时长 1–15        分辨率 480p/720p
//
// ⚠️ 这个探针会**临时切换画布上节点的模型**（读 UI 必须真的选），结束时按
//    「分组名 + 显示文本」点回原值，并断言恢复成功 —— 别让它把用户的画布改残。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const EXPECT = {
  "Seedance 2.0": { ratios: 7, adaptive: true, durations: 13, dmax: 15, dmin: -1, res: ["480p", "720p", "1080p", "4k"] },
  "Seedance 2.0 Mini": { ratios: 7, adaptive: true, durations: 12, dmax: 15, dmin: 4, res: ["480p", "720p"] },
  "Wan 3.0": { ratios: 6, adaptive: true, durations: 30, dmax: 30, dmin: -1, res: ["480p", "720p", "1080p"] },
  "Grok Video 1.5": { ratios: 5, adaptive: false, durations: 15, dmax: 15, dmin: 1, res: ["480p", "720p"] },
};

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

const node = page.locator(".vue-flow__node").filter({ hasText: /视频生成/ }).first();
const box = await node.boundingBox();
await page.mouse.click(box.x + 24, box.y + 12);
await page.waitForTimeout(1500);

const modelSelect = node.locator(".modelSelect");
const shownModel = async () => (await modelSelect.innerText().catch(() => "")).trim().split("\n")[0];

/**
 * 确保模型下拉**真的打开了**。
 * ⚠️ 这个页面上浮层很多（设置 popover、三个 select 的下拉），一次 Esc 不一定收干净，
 *    于是「点一下」有时是打开、有时是关闭 —— 实测表现是**隔一次失败一次**。
 *    所以这里改成：检测到打开才继续，否则重试几次。
 */
async function ensureModelListOpen() {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => [...document.querySelectorAll(".el-select-group__wrap")].some((el) => el.getBoundingClientRect().width > 0));
    if (open) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
    await modelSelect.click({ force: true }).catch(() => {});
    await page.waitForTimeout(900);
  }
  return false;
}

/** 读出模型下拉的「分组 → 选项」结构（分组只出现在模型下拉里，所以按它定位最稳）。 */
async function openModelList() {
  if (!(await ensureModelListOpen())) return [];
  return page.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    return [...document.querySelectorAll(".el-select-group__wrap")].filter(vis).map((g) => ({
      label: (g.querySelector(".el-select-group__title")?.textContent || "").trim(),
      items: [...g.querySelectorAll(".el-select-dropdown__item")].filter(vis).map((i) => {
        const r = i.getBoundingClientRect();
        return { text: (i.textContent || "").trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    }));
  });
}

/** 在指定分组里点选某个模型。 */
async function pickModel(groupLabel, itemText) {
  const groups = await openModelList();
  const g = groups.find((x) => x.label === groupLabel);
  const item = g?.items.find((i) => i.text === itemText);
  if (!item) {
    await page.keyboard.press("Escape");
    throw new Error(`在下拉里找不到 ${groupLabel} / ${itemText}（现有：${JSON.stringify(groups.map((x) => x.label))}）`);
  }
  await page.mouse.click(item.x, item.y);
  await page.waitForTimeout(900);
}

/** 展开一个 el-select 并读出全部选项文本，然后收起。 */
async function readSelectOptions(ariaLabel) {
  // ⚠️ EP 的 aria-label 落在内部 input 上，而 input 被 `.el-select__selected-item` 盖住
  //    （locator.click 会一直重试到超时）。直接按坐标点 `.el-select` 盒子最稳。
  const hit = await page.evaluate((label) => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const root = [...document.querySelectorAll(`[aria-label="${label}"]`)].find(vis);
    if (!root) return null;
    const r = (root.closest(".el-select") || root).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ariaLabel);
  if (!hit) return [];
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(700);
  const opts = await page.evaluate((label) => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const root = [...document.querySelectorAll(`[aria-label="${label}"]`)].find(vis);
    if (!root) return [];
    const wrap = root.closest(".el-select") || document;
    return [...wrap.querySelectorAll(".el-select-dropdown__item")].filter(vis).map((i) => (i.textContent || "").trim());
  }, ariaLabel);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  return opts;
}

/** 打开「视频生成设置」面板，读出比例按钮与时长/分辨率选项。 */
/** 确保「视频生成设置」面板开着（读 select 时按过 Esc，可能顺手把面板也关了）。 */
async function ensurePanelOpen() {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => {
      const vis = (el) => el.getBoundingClientRect().width > 0;
      const pops = [...document.querySelectorAll(".el-popover")].filter(vis);
      return pops.some((el) => el.querySelector('[aria-label="视频比例"]'));
    });
    if (open) return true;
    await page.locator('[aria-label="视频生成设置"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
  }
  return false;
}

async function readPanel(shotName) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(350);
  if (!(await ensurePanelOpen())) return { ratios: [], modes: [], durations: [], resolutions: [] };
  const ratios = await page.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const g = [...document.querySelectorAll('[aria-label="视频比例"]')].find(vis);
    return g ? [...g.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) : [];
  });
  const modes = await readSelectOptions("视频生成模式");
  const durations = await readSelectOptions("视频时长");
  const resolutions = await readSelectOptions("视频分辨率");
  if (shotName && (await ensurePanelOpen())) {
    // 截图留档：把面板本身和它所在的节点一起拍下来
    const pop = page.locator(".el-popover:visible").filter({ has: page.locator('[aria-label="视频比例"]') }).first();
    await pop.screenshot({ path: join(outDir, `_video-cap-${shotName}.png`) }).catch(() => {});
  }
  return { ratios, modes, durations, resolutions };
}

const original = await shownModel();
console.log(`原始选中的模型：${original || "（空）"}\n`);

const results = {};
for (const [label, exp] of Object.entries(EXPECT)) {
  try {
    await pickModel("Linke", label);
    const p = await readPanel(label.replace(/[^\w]+/g, "-"));
    results[label] = p;
    const okRatio = p.ratios.length === exp.ratios;
    const okAdaptive = p.ratios.includes("adaptive") === exp.adaptive;
    const okRes = JSON.stringify([...p.resolutions].sort()) === JSON.stringify([...exp.res].sort());
    console.log(`── ${label}`);
    console.log(`   比例 ${p.ratios.length} 种 ${okRatio ? "✅" : `✗（应 ${exp.ratios}）`}：${p.ratios.join(" ")}`);
    console.log(`   含 adaptive = ${p.ratios.includes("adaptive")} ${okAdaptive ? "✅" : "✗"}`);
    console.log(`   时长 ${p.durations.length} 项（${p.durations[0]} … ${p.durations[p.durations.length - 1]}）`);
    console.log(`   分辨率 ${okRes ? "✅" : "✗"}：${p.resolutions.join(" ")}`);
    console.log(`   模式：${p.modes.join(" / ") || "（无）"}`);
    console.log();
  } catch (error) {
    console.log(`── ${label}  ✗ ${error instanceof Error ? error.message : error}\n`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}
await page.screenshot({ path: join(outDir, "_video-capabilities.png") });

// ── 恢复原来的模型 ──
if (original) {
  try {
    const groups = await openModelList();
    const hit = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))).find((i) => i.text === original);
    if (hit) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); await pickModel(hit.group, hit.text); }
    else await page.keyboard.press("Escape");
  } catch { await page.keyboard.press("Escape").catch(() => {}); }
}
const restored = await shownModel();
console.log("=== 画布还原 ===");
console.log(`  原值「${original}」→ 现值「${restored}」  ${restored === original ? "✅ 已还原" : "⚠️ 未还原，请手动改回"}`);
console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
