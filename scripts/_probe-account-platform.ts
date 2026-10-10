// 账号平台模型验证（纯逻辑，不开浏览器）。
//
// ⚠️ 必须在临时工作目录下运行：账号文件路径是按 process.cwd() 算的
//   （<cwd>/data/doubao/accounts.json），换个目录就等于换了个沙箱，
//   不会碰到用户真实的账号数据。
//
// 用法：cd <临时目录> && bun <项目>/scripts/_probe-account-platform.ts
import {
  ACCOUNT_PLATFORMS,
  addAccount,
  loadAccounts,
  normalizeAccountType,
  pickAccount,
  platformOf,
  removeAccount,
} from "./doubao-accounts.ts";

const results: string[] = [];
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

console.log("工作目录：" + process.cwd());

// ① 平台表
check("豆包平台：站点 doubao.com", platformOf({ accountType: "doubao" }).domain === "doubao.com");
check("Dola 平台：站点 dola.com 且入口是 /chat",
  platformOf({ accountType: "dola" }).domain === "dola.com"
  && platformOf({ accountType: "dola" }).url === "https://www.dola.com/chat",
  platformOf({ accountType: "dola" }).url);
check("老账号（没有 accountType 字段）默认归豆包", platformOf({}).key === "doubao");
check("大小写/空格容错：\" DOLA \" → dola", normalizeAccountType(" DOLA ") === "dola");

// ② 新增账号
const dola = await addAccount(undefined, "dola");
check("新增 Dola 账号：类型正确", dola.accountType === "dola");
check("新增 Dola 账号：默认额度 4", dola.dailyQuota === 4, `dailyQuota=${dola.dailyQuota}`);
check("新增 Dola 账号：默认名字带平台", dola.name.startsWith("Dola 账号"), dola.name);
check("新增 Dola 账号：id 前缀区分平台", dola.id.startsWith("dola-"), dola.id);

const doubao1 = await addAccount(undefined, "doubao");
const doubao2 = await addAccount(undefined, "doubao");
check("新增豆包账号：默认额度 3", doubao1.dailyQuota === 3, `dailyQuota=${doubao1.dailyQuota}`);
check("同名平台自动编号不重复", doubao1.name !== doubao2.name, `${doubao1.name} / ${doubao2.name}`);

// ③ 落盘内容
const list = await loadAccounts();
check("列表能读回 3 个账号", list.length >= 3, `实际 ${list.length}`);
check("落盘含 accountType 字段", list.every(item => item.accountType === "doubao" || item.accountType === "dola"));

// ④ 按平台选号
const pickedDola = await pickAccount("dola");
check("按平台选号：只挑出 Dola 账号",
  "account" in pickedDola && pickedDola.account.accountType === "dola");
const pickedDoubao = await pickAccount("doubao");
check("按平台选号：只挑出豆包账号",
  "account" in pickedDoubao && pickedDoubao.account.accountType === "doubao");
const pickedAny = await pickAccount();
check("不传平台：任选一个可用账号", "account" in pickedAny);
const pickedMissing = await pickAccount("dola");
check("平台没有账号时给出可读错误（此处应能选到，故只校验结构）",
  "account" in pickedMissing || "error" in pickedMissing);

// ⑤ 清理
for (const account of [dola, doubao1, doubao2]) await removeAccount(account.id);
const after = await loadAccounts();
check("删除后账号已移除", !after.some(a => a.id === dola.id), `剩 ${after.length} 个`);

console.log(results.join("\n"));
console.log(`\n平台表：豆包=${ACCOUNT_PLATFORMS.doubao.label} Dola=${ACCOUNT_PLATFORMS.dola.label}`);
console.log(`结论：${failed === 0 ? "全部通过" : failed + " 项未通过"}`);
process.exit(failed === 0 ? 0 : 1);
