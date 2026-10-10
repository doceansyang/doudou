/**
 * 首页「项目文件夹 / 导入项目 / 添加项目」行为实测（对照原版）。
 * 只做观测，不改数据：每一步截图 + 打印界面上的真实文字。
 *
 * 跑法：cd toonflow && bun scripts/_probe-home-project.ts
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const OUT = "scripts/_out";
const VIEW = { width: 1440, height: 900 };
const lines: string[] = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW });

const dump = `(() => {
  const picker = document.querySelector(".workspaceButton");
  const send = document.querySelector(".sendButton");
  const cards = [...document.querySelectorAll(".projectCard")].map((c) => {
    const t = (s) => (c.querySelector(s) || {}).textContent || "";
    return { name: t(".projectName").trim(), path: t(".projectPath").trim(), time: t(".projectTime").trim() };
  });
  return JSON.stringify({
    picker: picker ? picker.textContent.trim() : "(无)",
    sendLabel: send ? send.getAttribute("aria-label") : "(无)",
    hint: (document.querySelector(".workspaceHint") || {}).textContent || "",
    cards,
  }, null, 1);
})()`;

async function shot(name: string) {
  await page.screenshot({ path: join(OUT, `home-${name}.png`) });
  log(`  → 截图 scripts/_out/home-${name}.png`);
}

/** 抓当前可见的 el-message / el-message-box 文字 */
async function messages() {
  return String(await page.evaluate(`(() => {
    const out = [];
    document.querySelectorAll(".el-message").forEach((m) => out.push("[message] " + m.textContent.trim()));
    document.querySelectorAll(".el-message-box").forEach((b) => out.push("[box] " + b.textContent.trim().slice(0, 120)));
    return out.length ? out.join("\\n") : "(无)";
  })()`));
}

try {
  await page.goto("http://localhost:3000/#/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".projectList", { timeout: 60000 });
  await page.waitForTimeout(3500);

  log("=== ① 首页初始状态 ===");
  log(String(await page.evaluate(dump)));
  await shot("1-init");

  log("");
  log("=== ② 点「添加项目」===");
  await page.locator(".sectionHeader button").filter({ hasText: "添加项目" }).first().click();
  await page.waitForTimeout(1800);
  log("  弹出内容：");
  log((await messages()).split("\n").map((l) => "    " + l).join("\n"));
  await shot("2-add-confirm");
  // 确认（选择空文件夹）
  await page.locator(".el-message-box__btns button").filter({ hasText: "选择空文件夹" }).first().click({ timeout: 5000 }).catch(() => log("  (没找到确认按钮)"));
  await page.waitForTimeout(2500);
  log("  确认后的弹窗：");
  log((await messages()).split("\n").map((l) => "    " + l).join("\n"));
  const browser3 = await page.evaluate(`(() => {
    const d = document.querySelector(".el-dialog");
    if (!d) return "(没有目录选择弹窗)";
    return d.querySelectorAll("tbody tr").length + " 行；路径=" + ((d.querySelector(".directoryPath") || {}).textContent || "");
  })()`);
  log("  目录浏览器：" + browser3);
  await shot("3-dir-browser");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  log("");
  log("=== ③ 点「导入项目」===");
  await page.locator(".sectionHeader button").filter({ hasText: "导入项目" }).first().click();
  await page.waitForTimeout(3000);
  log("  弹出内容：");
  log((await messages()).split("\n").map((l) => "    " + l).join("\n"));
  const importState = await page.evaluate(`(() => {
    const d = document.querySelector(".el-dialog");
    return d ? "目录选择弹窗已打开；" + d.querySelectorAll("tbody tr").length + " 行" : "(没有目录选择弹窗)";
  })()`);
  log("  " + importState);
  await shot("4-import");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);

  log("");
  log("=== ④ 点 ↑（发送）===");
  const send = page.locator(".sendButton").first();
  log("  按钮 aria-label = " + (await send.getAttribute("aria-label")));
  await send.click({ timeout: 5000 }).catch((e) => log("  click 抛错：" + String(e.message).split("\n")[0]));
  await page.waitForTimeout(2500);
  log("  结果：");
  log((await messages()).split("\n").map((l) => "    " + l).join("\n"));
  await shot("5-send");
} catch (error) {
  log(`❌ 异常：${String(error).split("\n")[0]}`);
} finally {
  writeFileSync(join(OUT, "home-project.txt"), lines.join("\n") + "\n", "utf-8");
  await browser.close();
}
