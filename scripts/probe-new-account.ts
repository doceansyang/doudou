/**
 * 诊断：新账号首次进入豆包时页面到底是什么状态，为什么识别不到「欢迎页」。
 *
 * 用法：bun run scripts/probe-new-account.ts [账号id]
 * 默认用账号池里第一个可用账号的 profile。
 */
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ACCOUNTS_FILE = resolve(process.cwd(), "data", "doubao", "accounts.json");
const OUT = resolve(process.cwd(), "assets", "doubao-inspect");
await mkdir(OUT, { recursive: true });

const accounts = JSON.parse(await readFile(ACCOUNTS_FILE, "utf-8"));
const wanted = process.argv[2];
const account = wanted ? accounts.find((a: any) => a.id === wanted) : accounts[accounts.length - 1];
if (!account) {
  console.log("找不到账号，可用：", accounts.map((a: any) => a.id).join(", "));
  process.exit(1);
}

const PROFILE = account.profileDir || resolve(homedir(), ".toonflow-doubao-accounts", account.id);
console.log(`账号: ${account.name} (${account.id})`);
console.log(`profile: ${PROFILE}`);

const { chromium } = await import("playwright");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => require("node:fs").existsSync(p));

const context = await chromium.launchPersistentContext(PROFILE, {
  ...(CHROME ? { executablePath: CHROME } : {}),
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: process.platform === "win32" ? ["--window-position=-32000,-32000"] : [],
});

async function dump(tag: string) {
  const page = context.pages()[0] ?? (await context.newPage());
  const info = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const buttons = [...document.querySelectorAll("button, [role=button], a")]
      .filter(visible)
      .map((el) => (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 40);
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 900),
      buttons,
    };
  });
  console.log(`\n===== ${tag} =====`);
  console.log("URL   :", info.url);
  console.log("标题  :", info.title);
  console.log("按钮  :", JSON.stringify(info.buttons.slice(0, 18)));
  console.log("正文  :\n" + info.bodyText);
  await page.screenshot({ path: resolve(OUT, `newacct-${tag}.png`) });
  return page;
}

// 必须先导航：launchPersistentContext 起来时只有 about:blank
const firstPage = context.pages()[0] ?? (await context.newPage());
await firstPage.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
await firstPage.waitForTimeout(6000);

const page = await dump("1-打开首页");
await page.waitForTimeout(2000);

// 「新对话」的候选：看各种匹配方式分别命中什么
const probes = await page.evaluate(() => {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const byText = [...document.querySelectorAll("*")]
    .filter((el) => visible(el) && /新对话/.test(el.textContent || "") && ![...el.children].some((c) => /新对话/.test(c.textContent || "")))
    .map((el) => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      role: el.getAttribute("role"),
      aria: el.getAttribute("aria-label"),
    }));
  return byText.slice(0, 10);
});
console.log("\n===== 「新对话」候选元素 =====");
probes.forEach((p: any, i: number) => console.log(`  ${i + 1}. <${p.tag}> role=${p.role} aria=${p.aria} cls=${p.cls} text=${JSON.stringify(p.text)}`));

// 1) 全页搜「视频」相关入口（含隐藏元素，看它到底藏在哪）
const videoHits = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("*") ) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent || "").join("").trim();
    if (/视频/.test(own)) {
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), text: own.slice(0, 30), visible: r.width > 0 && r.height > 0 });
    }
    if (out.length > 30) break;
  }
  return out;
});
console.log("\n===== 页面中带「视频」的元素 =====");
videoHits.forEach((v: any) => console.log(`  <${v.tag}> vis=${v.visible} cls=${v.cls} text=${JSON.stringify(v.text)}`));

// 2) 点「更多技能」看菜单
const moreBtn = page.getByText("更多技能").first();
if (await moreBtn.count()) {
  await moreBtn.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const menu = await page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll(".el-popper, .el-dropdown-menu, [role=menu], [class*=popover], [class*=modal]")]
      .filter(visible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300));
  });
  console.log("\n===== 更多技能菜单 =====");
  menu.forEach((m: string) => console.log("  " + m));
  await dump("2-更多技能");
}

await context.close();
console.log("\n完成，截图见 assets/doubao-inspect/newacct-*.png");
