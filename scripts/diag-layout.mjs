/**
 * 进入「视频任务」后，列出可见且有底色的元素块及其坐标，
 * 用于定位多余的 UI（顶部工具条、白条、悬浮块等）。
 */
const { chromium } = await import("playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto("http://127.0.0.1:18099/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(4000);

const menu = page.getByText("视频任务", { exact: true }).first();
if (await menu.count()) await menu.click();
await page.waitForTimeout(6000);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return;
    const bg = cs.backgroundColor;
    const isOpaque = bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg);
    if (!isOpaque) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && String(el.className).slice(0, 60)) || "",
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bg,
      txt: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34),
    });
  });
  return out;
});

console.log("共 " + rows.length + " 个块（按 y 排序）：");
rows
  .sort((a, b) => a.y - b.y || a.x - b.x)
  .forEach((r) => {
    console.log(
      `  y=${String(r.y).padStart(4)} h=${String(r.h).padStart(3)} x=${String(r.x).padStart(4)} w=${String(r.w).padStart(4)} ${r.bg.padEnd(20)} .${r.cls.padEnd(34)} | ${r.txt}`
    );
  });

await browser.close();
