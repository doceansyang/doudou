import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：媒体供应商编辑器里那段 readme 的**链接颜色**，深浅两套主题各量一次。
//
// 背景：主色是近黑的 #171717，而 markdown 渲染器把链接色绑在 --primary 上
// → 深色主题下「注册链接」渲染成黑字，在 #141414 的底上对比度只有 1.03:1，
// 肉眼就是「那一行不见了」（用户截图里红框内是空的）。
//
// 判据（不看截图）：
//   1. 量链接的 computed color，并**沿 DOM 链合成有效底色**（半透明要叠加），算对比度；
//      深色下 ≥ 3:1 才算可读，浅色下自然应该远高于此。
//   2. ⚠️ 主题必须**用真实开关切**（设置 → 界面设置 → 浅色/深色）再量。
//      不能只把 html 上的 .dark 摘掉 —— --ui-brand-foreground 是 App.vue 的
//      watchEffect 写在 :root 上的内联值，摘 class 不会让它重算，量出来是假的。
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://127.0.0.1:3000/#/home", { waitUntil: "domcontentloaded" });
const entry = page.locator(".projectEntry").first();
await entry.waitFor({ state: "visible", timeout: 20000 });
await entry.click();
await page.locator(".vue-flow__node").first().waitFor({ state: "visible", timeout: 30000 });
await page.waitForTimeout(2000);
await page.locator('button[aria-label="设置"]').first().click();
await page.waitForTimeout(900);

// 左侧导航按文案点击（同一文案在别处也有，取层级最深且可见的那个）
async function clickNav(text) {
  const pos = await page.evaluate((t) => {
    const cands = [];
    document.querySelectorAll("*").forEach((el) => {
      if ((el.textContent || "").trim() !== t) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      let depth = 0;
      for (let q = el; q; q = q.parentElement) depth += 1;
      cands.push({ depth, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    cands.sort((a, b) => b.depth - a.depth);
    return cands[0] || null;
  }, text);
  if (!pos) throw new Error("找不到导航项：" + text);
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(900);
}

async function setTheme(label) {
  await clickNav("界面设置");
  // 主题是 el-radio：点带 aria-label="外观模式" 的组里文案为「浅色 / 深色」的那一项
  const box = await page.evaluate((lab) => {
    const group = document.querySelector('[aria-label="外观模式"]');
    if (!group) return null;
    for (const el of group.querySelectorAll("*")) {
      if ((el.textContent || "").trim() === lab) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }, label);
  if (!box) throw new Error("找不到主题选项：" + label);
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1400); // 主题切换有 clip-path 扩散动效
  const now = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    brand: getComputedStyle(document.documentElement).getPropertyValue("--ui-brand-foreground").trim(),
  }));
  console.log(`  已切到「${label}」：dark=${now.dark}  --ui-brand-foreground=${now.brand}`);
  return now;
}

async function measure(label, theme) {
  await clickNav("媒体模型");
  const card = page.locator(".providerList .providerItem").filter({ hasText: new RegExp(label, "i") }).first();
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.locator('button:has-text("编辑模型")').first().click();
  await page.locator(".el-dialog .providerReadme").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);

  const data = await page.evaluate(() => {
    // ⚠️ 不能用正则解析颜色：Element Plus 变量经 color-mix() 后可能回 color(srgb …) 这类新格式。
    //    用 canvas 把任意合法 CSS 颜色落到 1×1 像素再读，最稳。
    const cv = document.createElement("canvas");
    cv.width = 1; cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const parse = (c) => {
      if (!c || c === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      const layers = [];
      for (let q = el; q; q = q.parentElement) {
        const c = parse(getComputedStyle(q).backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const root = document.querySelector(".el-dialog .providerReadme");
    const anchors = Array.from(root.querySelectorAll("a"));
    return {
      anchors: anchors.map((a) => {
        const cs = getComputedStyle(a);
        const fg = parse(cs.color);
        const bg = bgOf(a);
        const eff = over(fg, bg);
        const l1 = lum(eff), l2 = lum(bg);
        const rgb = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
        return {
          text: (a.textContent || "").trim(),
          href: a.getAttribute("href"),
          color: rgb(eff),
          bg: rgb(bg),
          contrast: +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2),
        };
      }),
      text: (root.innerText || "").replace(/\s+/g, " ").trim(),
      primary: getComputedStyle(root.querySelector(".markdownChunk") || root).getPropertyValue("--primary").trim(),
    };
  });
  await page.screenshot({ path: join(outDir, `_readme-${label.toLowerCase()}-${theme}.png`), clip: await page.locator(".el-dialog").first().boundingBox() });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  return data;
}

const results = {};
console.log("=== 切换主题（真实开关）===");
for (const theme of ["浅色", "深色"]) {
  const state = await setTheme(theme);
  console.log(`\n=== ${theme}主题下的 readme 链接 ===`);
  for (const label of ["APIMart", "Linke"]) {
    const d = await measure(label, theme);
    results[`${theme}-${label}`] = d;
    console.log(`[${label}] 文案: ${d.text.slice(0, 150)}`);
    console.log(`  --primary = ${d.primary}`);
    if (!d.anchors.length) { console.log("  （没有链接）"); continue; }
    for (const a of d.anchors) {
      console.log(`  链接「${a.text}」 href=${a.href}  color=${a.color}  底色=${a.bg}  对比度=${a.contrast}:1  ${a.contrast >= 3 ? "✅ 可读" : "✗ 不可读"}`);
    }
  }
}

console.log("\n=== 判定 ===");
for (const key of Object.keys(results)) {
  const d = results[key];
  const worst = d.anchors.reduce((m, a) => Math.min(m, a.contrast), Infinity);
  console.log(`  ${key}: 最低对比度 ${worst === Infinity ? "无链接" : worst + ":1"} ${worst >= 3 ? "✅" : "✗"}   含「注册链接」=${/注册链接/.test(d.text)}`);
}

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "  （无）");
await browser.close();
