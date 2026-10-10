/**
 * 检查画布节点为什么没正常显示：读节点的实际尺寸与计算样式。
 */
const { chromium } = await import("playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(3500);
await page.getByText("视频任务", { exact: true }).first().click().catch(() => {});
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const out = {};
  const canvas = document.querySelector(".storyboard-canvas");
  const wrap = document.querySelector(".storyboard-canvas-wrap");
  const flow = document.querySelector(".vue-flow");
  const node = document.querySelector(".vue-flow__node");
  const shot = document.querySelector(".shot-node");

  function desc(el, name) {
    if (!el) return (out[name] = "不存在");
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[name] = {
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: cs.display,
      bg: cs.backgroundColor,
      border: cs.borderTopWidth,
    };
  }
  desc(wrap, "wrap");
  desc(canvas, "canvas");
  desc(flow, "vue-flow");
  desc(node, "node");
  desc(shot, "shot-node");

  out.nodeClass = node ? node.className : "-";
  out.nodeHtml = node ? node.innerHTML.slice(0, 160) : "-";
  out.viewportTransform = flow ? getComputedStyle(flow.querySelector(".vue-flow__viewport") || flow).transform : "-";
  out.shotStylesInCss = [...document.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .filter((r) => r.selectorText && r.selectorText.includes("shot-node")).length;
  return out;
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
