// 校验：从 launcher.cs 的 BuildPrepaintScript 里**抽出现场那段注入脚本**，检查语法是否合法。
//
// 为什么要抽而不是抄一份：抄一份就等于"测的是另一段代码"，两边必然漂移。这里直接读源文件、
// 按 C# 字符串拼接的写法还原成 JS 字面量（把 `" + 表达式 + "` 那几处替换成实际值），
// 再交给 new Function 判语法。源码一旦改成别的写法，这里会因为还原不出合法 JS 而报错 —— 这本身就是提醒。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "launcher.cs"), "utf8");
const fn = source.match(/static string BuildPrepaintScript\(bool dark\)([\s\S]*?)\n {4}\}/);
if (!fn) throw new Error("没在 launcher.cs 里找到 BuildPrepaintScript");
// ⚠️ 只从 `string js =` 之后开始抽 —— 方法开头还有两个颜色字面量（`"#17171a"` / `"#ffffff"`），
//    一起卷进来会拼出 `#17171a#ffffff(function(){...` 这种非法 JS（踩过）。
const body = fn[1].slice(fn[1].indexOf("string js ="));

const js = body
  .replace(/"\s*\+\s*bg\s*\+\s*"/g, "#17171a")
  .replace(/"\s*\+\s*\(dark \? "true" : "false"\)\s*\+\s*"/g, "true")
  .replace(/"\s*\+\s*JinyuTVLauncher\.PORT\s*\+\s*"/g, "3000")
  .match(/"(?:[^"\\]|\\.)*"/g)
  .map((literal) => JSON.parse(literal))
  .join("");

console.log(`还原出的脚本长度：${js.length} 字符`);
const checks = [
  ["含本地预上色分支", js.includes("__jinyuPrepaint")],
  ["含 linke 凭据回传分支", js.includes("api.linke.link") && js.includes("/api/user/auth/refresh")],
  ["回传地址落在本地端口", js.includes("http://127.0.0.1:3000/api/linke/session")],
  ["回传时带应用标识头", js.includes("x-toonflow-workspace")],
  ["沿用失败即静默的写法（不往页面里抛异常）", js.includes("catch(function(){})")],
];
try {
  new Function(js);
  console.log("语法：✓ 可以被解析");
} catch (error) {
  console.log("语法：✗ " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
