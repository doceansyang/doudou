import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：在**真实项目**里量竖屏视频节点的"信箱边"。
//
// 为什么要到真机上量：灰边的成因是「框宽 = max(下限, 240×宽高比)」被下限抬高，
// 而框宽由 JS 算、内层盒子又受 CSS min-width 约束 —— 两边只要有一个没改到位，
// 现象就照旧。静态读代码得不出结论，必须量真实渲染。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });

// 等视频元数据到位（node 的宽度是在 loadedmetadata 里算的，早量是量不到的）
await page.waitForFunction(
  () => Array.from(document.querySelectorAll("video")).some((v) => v.videoWidth > 0),
  null, { timeout: 30000 },
).catch(() => console.log("  !! 一直没等到带尺寸的视频"));
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".vue-flow__node").forEach((node) => {
    const v = node.querySelector("video");
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const player = node.querySelector(".videoPlayer");
    if (!player) return;
    const pr = player.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    out.push({
      title: node.querySelector(".titleBar input")?.value || "",
      natural: `${v.videoWidth}x${v.videoHeight}`,
      aspect: +(v.videoWidth / v.videoHeight).toFixed(3),
      nodeW: Math.round(nr.width),
      nodeH: Math.round(nr.height),
      playerBox: `${Math.round(pr.width)}x${Math.round(pr.height)}`,
      videoBox: `${Math.round(vr.width)}x${Math.round(vr.height)}`,
      // 视频按 contain 铺进 playerBox 后，左右实际露出的边宽（>1.5px 就是肉眼可见的灰边）
      pillarPadding:
        +(pr.width - Math.min(pr.width, pr.height * (v.videoWidth / v.videoHeight))).toFixed(1),
      letterbox:
        +(pr.height - Math.min(pr.height, pr.width * (v.videoHeight / v.videoWidth))).toFixed(1),
    });
  });
  return out;
});

// 现场勘察：到底是谁在决定宽度（JS 设的内联宽 / CSS / vue-flow 存的尺寸）
const who = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".vue-flow__node").forEach((node) => {
    const v = node.querySelector("video");
    if (!v || !v.videoWidth) return;
    const player = node.querySelector(".videoPlayer");
    if (!player) return;
    const inner = node.firstElementChild;
    const pcs = getComputedStyle(player);
    const vcs = getComputedStyle(v);
    out.push({
      aspect: +(v.videoWidth / v.videoHeight).toFixed(3),
      // 期望：JS 会算出 max(96, 240*aspect) 并写到节点内层
      expect: Math.round(Math.max(96, (240 * v.videoWidth) / v.videoHeight)),
      nodeInlineW: node.style.width || "(无)",
      innerInlineW: inner?.style?.width || "(无)",
      innerTag: inner?.className || "(无)",
      playerW: pcs.width, playerH: pcs.height,
      videoW: vcs.width, videoH: vcs.height, videoMaxH: vcs.maxHeight,
      videoInline: v.style.cssText || "(无)",
      videoContentH: getComputedStyle(node.querySelector(".videoContent") || player).height,
    });
  });
  return out;
});
console.log("=== 谁在决定宽度（内联样式 vs 实际盒）===");
for (const w of who) {
  console.log(`  等比=${w.aspect}  期望宽(JS)=${w.expect}px`);
  console.log(`     vue-flow 节点内联宽=${w.nodeInlineW}   内层(${w.innerTag}) 内联宽=${w.innerInlineW}`);
  console.log(`     .videoPlayer=${w.playerW} x ${w.playerH}   video=${w.videoW} x ${w.videoH} (max-height ${w.videoMaxH})`);
  console.log(`     video 内联样式=${w.videoInline}   .videoContent 高=${w.videoContentH}`);
}

console.log("\n=== 真实项目里的视频节点（量的是实际渲染盒）===");
if (!rows.length) console.log("  （没找到带视频的节点）");
for (const r of rows) {
  const kind = r.aspect < 1 ? "竖屏" : "横屏";
  console.log(`  「${r.title}」${kind} ${r.natural} 等比=${r.aspect}`);
  console.log(`     节点=${r.nodeW}x${r.nodeH}  播放器盒=${r.playerBox}  视频元素盒=${r.videoBox}`);
  console.log(`     左右露边=${r.pillarPadding}px ${r.pillarPadding > 1.5 ? "❌ 有灰边" : "✅ 贴合"}`
    + `   上下露边=${r.letterbox}px`);
}

// 把竖屏那个节点单独截出来，眼见为实。
// ⚠️ 不能用 locator 的第 i 个去对应上面 rows 的第 i 行 —— 两边遍历/过滤顺序
//    未必一致，实测就是这么裁出一张空白图的。直接在页面内取矩形最稳。
// 画布可能被平移到别处，节点在视口外 —— 先点「适应视图」把它拉进视野，
// 否则 getBoundingClientRect 给的是视口外的坐标，截图会裁到空白。
const fit = page.locator('[aria-label="适应视图"]').first();
if (await fit.count()) { await fit.click(); await page.waitForTimeout(1200); }

const vbox = await page.evaluate(() => {
  let best = null;
  document.querySelectorAll(".vue-flow__node").forEach((node) => {
    const v = node.querySelector("video");
    if (!v?.videoWidth || v.videoWidth / v.videoHeight > 1) return;
    const r = node.getBoundingClientRect();
    if (!best || r.width * r.height > best.w * best.h) best = { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return best;
});
if (vbox) {
  await page.screenshot({
    path: join(outDir, "_vertical-video-node.png"),
    clip: {
      x: Math.max(0, vbox.x - 14),
      y: Math.max(0, vbox.y - 14),
      width: vbox.w + 28,
      height: vbox.h + 28,
    },
  });
  console.log(`  竖屏节点截图已存：_vertical-video-node.png（节点屏幕位置 ${Math.round(vbox.x)},${Math.round(vbox.y)} 尺寸 ${Math.round(vbox.w)}x${Math.round(vbox.h)}）`);
}

// 竖屏节点只有 135px 宽，控件条必须还站得住 —— 实测 hover 后各件是否按预期隐藏
const narrow = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".vue-flow__node").forEach((node) => {
    const v = node.querySelector("video");
    const player = node.querySelector(".videoPlayer");
    if (!v?.videoWidth || !player) return;
    if (v.videoWidth / v.videoHeight > 1) return;         // 只看竖屏
    const cs = getComputedStyle(player);
    const controls = node.querySelector(".playerControls");
    if (!controls) return;
    const seen = (sel) => {
      const el = controls.querySelector(sel);
      return el ? getComputedStyle(el).display !== "none" : null;
    };
    out.push({
      playerW: cs.width,
      columns: getComputedStyle(controls).gridTemplateColumns,
      areas: getComputedStyle(controls).gridTemplateAreas,
      play: seen(".playButton"),
      progress: seen(".progressSlider"),
      capture: seen(".captureMenu"),
      currentTime: seen(".currentTime"),
      duration: seen(".durationLabel"),
      volume: seen(".volumeControl"),
    });
  });
  return out;
});
console.log("\n=== 竖屏节点的播放控件（宽度只有 135px）===");
for (const n of narrow) {
  console.log(`  播放器宽=${n.playerW}  列=${n.columns}`);
  console.log(`  区域=${n.areas}`);
  console.log(`  显示：播放=${n.play} 进度=${n.progress} 截帧=${n.capture} | 当前时间=${n.currentTime} 总时长=${n.duration} 音量=${n.volume}`);
  console.log(`  判定：${n.play && n.progress && n.capture && n.currentTime === false && n.volume === false ? "✅ 已按窄容器降级（时间/音量收起）" : "⚠️ 与预期不符"}`);
}

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
