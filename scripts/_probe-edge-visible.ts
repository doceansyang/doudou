/**
 * 验证：选中节点时，相连连线的高亮颜色是否可见。
 *   · 未选中：连线用默认色
 *   · 选中后：相连连线带 edgeActive 类，描边应为可读的品牌色（而不是近黑）
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

const readEdges = () => page.evaluate(() => {
  const toRgb = (value) => {
    const el = document.createElement("span");
    el.style.color = value;
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color;
    el.remove();
    return rgb;
  };
  // 支持 rgb(...) 与 color(srgb r g b) 两种格式
  const parseRgb = (value) => {
    let m = value.match(/^rgba?\(([^)]+)\)/);
    if (m) { const parts = m[1].split(",").map(Number); return parts.slice(0, 3); }
    m = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v * 255));
    return null;
  };
  const lum = (rgb) => {
    const parts = parseRgb(rgb);
    if (!parts) return null;
    const [r, g, b] = parts;
    return +(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(1);
  };
  const canvasBg = getComputedStyle(document.querySelector(".canvas") || document.body).backgroundColor;
  const paths = Array.from(document.querySelectorAll(".vue-flow__edge")).map((edge) => {
    const path = edge.querySelector(".vue-flow__edge-path");
    const stroke = path ? getComputedStyle(path).stroke : "(无路径)";
    const rgb = /^rgb/.test(stroke) ? stroke : toRgb(stroke);
    return {
      active: edge.classList.contains("edgeActive"),
      stroke: rgb,
      width: path ? getComputedStyle(path).strokeWidth : "?",
      contrast: lum(rgb),
    };
  });
  return { canvasBg, canvasLum: lum(canvasBg), edges: paths };
});

try {
  await page.goto("http://localhost:3000/#/workspace", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".vue-flow__node", { timeout: 60000 });
  await page.waitForTimeout(5000);

  const before = await readEdges();
  log(`画布连线总数: ${before.edges.length}`);
  log(`画布底色: ${before.canvasBg}（亮度 ${before.canvasLum}）`);
  log("");
  log("=== 未选中任何节点时 ===");
  log(`  带 edgeActive 的连线: ${before.edges.filter((e) => e.active).length} / ${before.edges.length}`);
  const sample0 = before.edges[0];
  if (sample0) log(`  示例描边: ${sample0.stroke}（亮度 ${sample0.contrast}，线宽 ${sample0.width}）`);

  // 选中一个节点
  const nodes = page.locator(".vue-flow__node");
  const total = await nodes.count();
  const inside = (b) => b && b.x > 8 && b.y > 8 && b.x + b.width < VIEW.width - 8 && b.y + b.height < VIEW.height - 8;
  let idx = -1, box = null;
  for (let i = 0; i < total; i++) {
    const b = await nodes.nth(i).boundingBox();
    if (inside(b)) { idx = i; box = b; break; }
  }
  for (const [dx, dy] of [[0.08, 0.07], [0.5, 0.1], [0.5, 0.5]]) {
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await page.waitForTimeout(900);
    if (await page.locator(".vue-flow__node.selected").count() > 0) break;
  }
  await page.waitForTimeout(1200);

  const after = await readEdges();
  const actives = after.edges.filter((e) => e.active);
  log("");
  log("=== 选中节点后 ===");
  log(`  带 edgeActive 的连线: ${actives.length} / ${after.edges.length}`);
  actives.slice(0, 4).forEach((e, i) => {
    const diff = e.contrast !== null && after.canvasLum !== null ? Math.abs(e.contrast - after.canvasLum).toFixed(1) : "?";
    log(`  [${i}] 描边=${e.stroke} 线宽=${e.width} 与底色明暗差=${diff}`);
  });

  const best = actives.map((e) => (e.contrast !== null && after.canvasLum !== null ? Math.abs(e.contrast - after.canvasLum) : 0));
  const maxDiff = best.length ? Math.max(...best) : 0;
  log("");
  log(`结论: 高亮连线的最大明暗差 = ${maxDiff} → ${maxDiff > 60 ? "✓ 清晰可见" : "❌ 仍然看不见"}`);

  await page.screenshot({ path: "assets/_edge-highlight.png" });
} catch (error) {
  log(`❌ 脚本异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync("assets/_edge-highlight.txt", lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
