/**
 * 授权模块回归：① 机器码稳定性 ② 验签（含伪造/换机/改内容）③ 签发闭环。
 * 用法（必须在 toonflow 目录下）：
 *   bun scripts/_probe-license.ts
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMachineCode, verifyLicense, signLicense, publicKeyFingerprint } from "./license/license-core";

const OUT = join(process.cwd(), "scripts", "_out");
const lines: string[] = [];
const log = (t: string) => {
  lines.push(t);
  console.log(t);
};

const PRIVATE_KEY = readFileSync(
  `${process.env.USERPROFILE}/.workbuddy/tools/jinyutv-license/private.jwk`,
  "utf8",
).trim();

log("=== ① 机器码稳定性（同一台机连采 3 次，必须完全一致）===");
const codes: string[] = [];
for (let i = 0; i < 3; i++) {
  const code = await getMachineCode();
  codes.push(code);
  log(`  第 ${i + 1} 次：${code}`);
}
const stable = codes.every((c) => c === codes[0]);
log(`  → ${stable ? "✓ 三次一致" : "✗ 不一致（机器码不可用）"}`);
log(`  格式：${/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/.test(codes[0]) ? "✓ 20 位（4 组 x 5）分组" : "✗ 格式错"}`);
log(`  公钥指纹：${publicKeyFingerprint}`);

const machine = codes[0];
const OTHER = "AAAAA-BBBBB-CCCCC-DDDDD";

log("");
log("=== ② 签发 → 验签闭环 ====");
const code = await signLicense(
  { machineCode: machine, alg: "ed25519", issuedAt: new Date().toISOString().slice(0, 10), note: "测试", v: 1 },
  PRIVATE_KEY,
);
log(`  授权码长度 ${code.length} 字符`);
log(`  前 40 字符：${code.slice(0, 40)}…`);

const ok = await verifyLicense(code, machine);
log(`  本机验签：${ok.ok ? "✓ 通过" : "✗ 失败 — " + ok.reason}`);

const wrong = await verifyLicense(code, OTHER);
log(`  换一台机：${wrong.ok ? "✗ 竟然通过（主机锁失效！）" : "✓ 拒绝 — " + wrong.reason}`);

const tampered = `${code.slice(0, -4)}AAAA`;
const tamperedResult = await verifyLicense(tampered, machine);
log(`  改签名尾：${tamperedResult.ok ? "✗ 竟然通过（防伪造失效！）" : "✓ 拒绝 — " + tamperedResult.reason}`);

const body = code.split(".")[0];
// 用一把**随机私钥**签（与内置公钥不配对）→ 必须被拒
const otherPair = (await import("node:crypto")).generateKeyPairSync("ed25519");
const forged = await signLicense(
  { machineCode: machine, alg: "ed25519", issuedAt: "2020-01-01", note: "伪造", v: 1 },
  JSON.stringify(otherPair.privateKey.export({ format: "jwk" })),
);
void body;
const forgedResult = await verifyLicense(forged, machine);
log(`  他人私钥签：${forgedResult.ok ? "✗ 竟然通过（防伪造失效！）" : "✓ 拒绝 — " + forgedResult.reason}`);

const empty = await verifyLicense("", machine);
log(`  空授权码：${empty.ok ? "✗ 通过" : "✓ 拒绝 — " + empty.reason}`);

const junk = await verifyLicense("abc", machine);
log(`  乱字符串：${junk.ok ? "✗ 通过" : "✓ 拒绝 — " + junk.reason}`);

writeFileSync(join(OUT, "license-probe.log"), lines.join("\n") + "\n", "utf-8");
log("");
log(`结论：稳定=${stable} 本机验签=${ok.ok} 换机拒绝=${!wrong.ok} 改签名拒绝=${!tamperedResult.ok} 他钥拒绝=${!forgedResult.ok}`);