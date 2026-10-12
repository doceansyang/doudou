import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// 探针：整页加载时会不会「先白一下」（用户反馈的「返回时闪白」）。
//
// 判据不看截图（帧太短抓不准），而是**逐帧记账**：
//   rAF 回调紧挨着绘制执行，所以在里面采样 getComputedStyle(html).backgroundColor
//   拿到的就是「这一帧真正画出去的颜色」。只要第一帧不是白的，就没有闪白。
//
// A/B 对照：
//   A 基线（什么都不注入）      → 预期首帧白，复现问题
//   B 注入启动器的预上色脚本    → 预期首帧就是 #17171a，问题消失
//                               （挂载后 App.vue 会撤掉该样式，应看到后面的帧
//                                 变成 EP 深色 #141414 —— 顺带验证回收逻辑）
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "scripts", "_out");
mkdirSync(outDir, { recursive: true });

const URL = "http://localhost:3000/";
const SHELL_BG = "#17171a";
const EP_DARK_BG = "rgb(20, 20, 20)"; // Element Plus 深色 --el-bg-color（#141414）

// 采样器：前 40 帧，每帧记「html 的实际底色 + 有没有 .dark + 预上色样式在不在」
const sampler = `(() => {
  window.__frames = [];
  const rec = () => {
    const d = document.documentElement;
    window.__frames.push({
      t: Math.round(performance.now()),
      bg: d ? getComputedStyle(d).backgroundColor : null,
      dark: d ? d.classList.contains("dark") : null,
      prepaint: !!document.getElementById("jinyu-prepaint"),
    });
    if (window.__frames.length < 40) requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
})();`;

// 与 launcher.cs 的 BuildPrepaintScript 逐字一致（深色分支）
const prepaint = `(function(){
var BG='${SHELL_BG}',DARK=true;
function apply(){
var d=document.documentElement;if(!d)return false;
d.setAttribute('data-shell-theme',DARK?'dark':'light');
d.style.colorScheme=DARK?'dark':'light';
if(DARK){d.classList.add('dark');}else{d.classList.remove('dark');}
var s=document.getElementById('jinyu-prepaint');
if(!s){s=document.createElement('style');s.id='jinyu-prepaint';(document.head||d).appendChild(s);}
s.textContent='html{background-color:'+BG+' !important}';
window.__jinyuPrepaint=true;
return true;}
try{
if(location.hostname!=='localhost'||location.port!=='3000')return;
if(apply())return;
var mo=new MutationObserver(function(){if(apply()){mo.disconnect();mo=null;}});
mo.observe(document,{childList:true,subtree:true});
document.addEventListener('readystatechange',function(){if(apply()&&mo){mo.disconnect();mo=null;}});
setTimeout(function(){apply();if(mo){mo.disconnect();mo=null;}},0);
}catch(e){}})();`;

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });

async function run(label, withPrepaint) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (withPrepaint) await page.addInitScript({ content: prepaint });
  await page.addInitScript({ content: sampler });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const data = await page.evaluate(() => ({
    frames: window.__frames,
    theme: document.documentElement.className,
    prepaintNow: !!document.getElementById("jinyu-prepaint"),
    flag: window.__jinyuPrepaint === true,
  }));
  await ctx.close();

  const first = data.frames[0] || {};
  const whiteFrames = data.frames.filter((f) => /^rgba?\(2[0-5][0-9], 2[0-5][0-9], 2[0-5][0-9]/.test(f.bg || ""));
  console.log(`\n===== ${label} =====`);
  console.log(`  首帧底色        : ${first.bg}  (t=${first.t}ms, dark=${first.dark})`);
  console.log(`  白色帧数量      : ${whiteFrames.length} / ${data.frames.length}`);
  console.log(`  挂载后 html 类  : "${data.theme}"`);
  console.log(`  预上色样式还在吗: ${data.prepaintNow}（应为 false —— App.vue 挂载后撤掉）`);
  console.log(`  预上色脚本跑过吗: ${data.flag}`);
  console.log("  前 8 帧         : " + data.frames.slice(0, 8).map((f) => `${f.bg}${f.dark ? "/dark" : ""}${f.prepaint ? "/P" : ""}`).join("  "));
  if (errors.length) console.log("  页面错误        : " + errors.join(" | "));
  return { first, whiteFrames, data };
}

const a = await run("A 基线（无预上色）", false);
const b = await run("B 修复后（注入启动器预上色脚本）", true);

console.log("\n===== 判定 =====");
console.log(`  A 首帧是白的（复现闪白）       : ${/^rgba?\(255, 255, 255/.test(a.first.bg || "") ? "是 ✅ 复现" : "否（基线不符合预期，需复查）"}`);
console.log(`  B 首帧是外壳深色 ${SHELL_BG}   : ${b.first.bg === "rgb(23, 23, 26)" ? "是 ✅ 已修复" : "否 ⚠️"}`);
console.log(`  B 全程没有白帧                 : ${b.whiteFrames.length === 0 ? "是 ✅" : "否 ⚠️"}`);
console.log(`  B 挂载后底色回到 EP 深色       : ${b.data.frames.at(-1)?.bg === EP_DARK_BG ? "是 ✅（预上色样式已被撤掉）" : "否（末帧=" + b.data.frames.at(-1)?.bg + "，可接受但值得看一眼）"}`);

await browser.close();
