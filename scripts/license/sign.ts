/**
 * 签发入口（仅被 make-license.py 调用，不参与软件运行时）。
 *
 * 为什么单独一个文件：签发需要**私钥**，软件运行时只需要**公钥**。
 * 把两者物理分开，就从结构上保证了私钥不会被打进安装包。
 *
 * 用法：echo '{"machineCode":"...","note":"..."}' | bun scripts/license/sign.ts <私钥路径>
 */
import { readFileSync } from "node:fs";
import { signLicense, type LicensePayload } from "./license-core";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const privateJwkPath = process.argv[2];
if (!privateJwkPath) {
  console.error("!! 缺少私钥文件路径");
  process.exit(1);
}

try {
  const input = await readStdin();
  const parsed = JSON.parse(input || "{}") as { machineCode?: string; note?: string };
  const machineCode = String(parsed.machineCode || "").trim();
  if (!machineCode) {
    console.error("!! 机器码为空");
    process.exit(1);
  }

  const payload: LicensePayload = {
    machineCode,
    alg: "ed25519",
    issuedAt: new Date().toISOString().slice(0, 10),
    note: parsed.note ? String(parsed.note).slice(0, 120) : undefined,
    v: 1,
  };

  const privateJwk = readFileSync(privateJwkPath, "utf8");
  console.log(await signLicense(payload, privateJwk));
} catch (error) {
  console.error(`!! ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}