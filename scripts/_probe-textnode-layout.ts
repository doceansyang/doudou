/**
 * 探针：文本节点「错位」实测。
 *
 * 用户截图用红框标了 4 处，本探针**不靠看图猜**，一律用 boundingBox 取硬数据：
 *   ①顶部工具条（topSlot）      ②输入/输出连接柄（nodeHandle）
 *   ③底部提示词卡（bottomSlot） ④模型下拉（modelSelect）
 *
 * 判据：每个浮动槽相对节点本体的**水平中心偏差**与**垂直间距**。
 *浮动槽是 `left:50% + translateX(-50%)`，理论上中心应与节点本体中心严格对齐。
 *
 * 用法：bun scripts/_probe-textnode-layout.ts [url]
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3000";

function log(message: string) {
  console.log(message);
}

/** 用系统已装的 Chrome/Edge —— 本机没下 playwright 自带的 chromium。 */
function systemChrome(): string | undefined {
  const roots = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return roots.find((p) => existsSync(p));
}

const browser = await chromium.launch({
  headless: true,
  executablePath: systemChrome(),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => log(`[pageerror] ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") log(`[console.error] ${message.text()}`);
});

log(`打开 ${BASE}/#/workspace …`);
await page.goto(`${BASE}/#/workspace`, { waitUntil: "domcontentloaded", timeout: 60000 });

// 判据不能依赖业务数据（画布可能是空的），只等节点骨架出现。
try {
  await page.waitForSelector(".nodeSkeleton", { timeout: 30000 });
} catch {
  log("!! 没有等到任何节点 —— 当前画布可能是空的，请先在画布上放一个文本节点");
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  function box(element: Element | null) {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }
  const nodes = [...document.querySelectorAll(".nodeSkeleton")].map((skeleton, index) => {
    const card = skeleton.querySelector(".contentCard");
    const top = skeleton.querySelector(".floatingSlot.topSlot");
    const bottom = skeleton.querySelector(".floatingSlot.bottomSlot");
    const handles = [...skeleton.querySelectorAll(".nodeHandle")].map((h) => {
      const icon = h.querySelector(".handleIcon");
      return {
        label: h.getAttribute("aria-label") || "",
        box: box(h.querySelector(".handleIcon") || h),
      };
    });
    return {
      index,
      label: skeleton.querySelector(".labelText")?.textContent?.trim() || "",
      isTextNode: !!skeleton.querySelector(".textNodeMarkdown, .textContent"),
      skeleton: box(skeleton),
      card: box(card),
      topSlot: box(top),
      bottomSlot: box(bottom),
      handles,
      modelSelect: box(skeleton.querySelector(".modelSelect")),
      selectText: skeleton.querySelector(".modelSelect .el-select__placeholder, .modelSelect .el-select__selected-item")?.textContent?.trim() || "",
    };
  });
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, nodes };
});

log(`视口 ${report.viewport.w}x${report.viewport.h}，共${report.nodes.length} 个节点\n`);

// 浮动槽由 node.selected / slotsVisible 控制（未选中时根本不渲染），
// 所以必须先点选目标节点再量 —— 否则量到的会是「未显示」。
const before = await page.locator(".nodeSkeleton").count();
void before;
const textNode = page.locator(".nodeSkeleton").filter({ has: page.locator(".textContent, .textNodeMarkdown") }).first();
if (await textNode.count()) {
  await textNode.click({ position: { x: 40, y: 16 } });
  await page.waitForTimeout(900);
  log("已点选文本节点，重新量几何…\n");
}

const after = await page.evaluate(() => {
  function box(element: Element | null) {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }
  const nodes = [...document.querySelectorAll(".nodeSkeleton")].map((skeleton, index) => {
    const card = skeleton.querySelector(".contentCard");
    return {
      index,
      label: skeleton.querySelector(".labelText")?.textContent?.trim() || "",
      isTextNode: !!skeleton.querySelector(".textNodeMarkdown, .textContent"),
      selected: skeleton.querySelector(".contentCard")?.classList.contains("selected") || false,
      card: box(card),
      topSlot: box(skeleton.querySelector(".floatingSlot.topSlot")),
      bottomSlot: box(skeleton.querySelector(".floatingSlot.bottomSlot")),
      handles: [...skeleton.querySelectorAll(".nodeHandle")].map((h) => {
        const icon = h.querySelector(".handleIcon");
        return { label: h.getAttribute("aria-label") || "", box: box(icon || h) };
      }),
      modelSelect: box(skeleton.querySelector(".modelSelect")),
      selectText: skeleton.querySelector(".modelSelect .el-select__placeholder, .modelSelect .el-select__selected-item")?.textContent?.trim() || "",
    };
  });
  return { nodes };
});

for (const node of after.nodes) {
  if (!node.isTextNode && !node.selected) continue;
  const tag = `${node.label || "(无标题)"}${node.isTextNode ? "  [文本节点]" : ""}`;
  log(`──── 节点 #${node.index} ${tag}${node.selected ? "  已选中" : ""}`);
  if (!node.card) {
    log("  几何信息缺失");
    continue;
  }
  const cardCx = node.card.cx;
  log(`  本体卡片   x=${node.card.x.toFixed(0)} y=${node.card.y.toFixed(0)} ${node.card.w.toFixed(0)}x${node.card.h.toFixed(0)}  中心x=${cardCx.toFixed(0)}`);

  for (const [name, slot] of [["顶部工具条", node.topSlot], ["底部提示词卡", node.bottomSlot]] as const) {
    if (!slot) {
      log(`  ${name}未显示`);
      continue;
    }
    const dx = slot.cx - cardCx;
    const gapBelow = slot.y - (node.card.y + node.card.h);
    const gapAbove = node.card.y - (slot.y + slot.h);
    const flag = Math.abs(dx) > 2 ? "✗ 中心偏移" : "✓ 居中";
    log(`  ${name} x=${slot.x.toFixed(0)} y=${slot.y.toFixed(0)} ${slot.w.toFixed(0)}x${slot.h.toFixed(0)}`);
    log(`      中心偏移 dx=${dx.toFixed(1)}px ${flag}   垂直间距：上${gapAbove.toFixed(0)} / 下${gapBelow.toFixed(0)}`);
  }

  for (const handle of node.handles) {
    if (!handle.box) continue;
    const leftGap = node.card.x - handle.box.x;
    const rightGap = handle.box.x - (node.card.x + node.card.w);
    log(`  连接柄 ${handle.label.slice(0, 22)} x=${handle.box.x.toFixed(0)} y=${handle.box.y.toFixed(0)}  距左${leftGap.toFixed(0)} / 距右${rightGap.toFixed(0)}`);
  }

  if (node.modelSelect) {
    log(`  模型下拉   ${node.modelSelect.w.toFixed(0)}x${node.modelSelect.h.toFixed(0)}  文本="${node.selectText}"`);
    if (node.selectText.startsWith("[") || node.selectText.startsWith("{")) {
      log("      ⚠ 显示的是原始 JSON —— 模型列表为空（未配置 API Key）");
    }
  }
  log("");
}

await page.screenshot({ path: "scripts/_out/textnode-layout.png" });
log("截图：scripts/_out/textnode-layout.png");
await browser.close();