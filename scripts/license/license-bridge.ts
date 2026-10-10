/**
 * 授权的**命令行桥** —— 启动器（JinyuTV.exe，C#）通过 bun 调它。
 *
 * 为什么要有这层桥，而不是在 C# 里重写一遍硬件采集：
 *   机器码采集与验签逻辑在 `license-core.ts` 里是**唯一来源**。
 *   如果 C# 再写一份，两边迟早漂移 —— 结果是「客户激活时报机器码不匹配」，
 *   而且这种 bug极难排查。所以启动器只负责收集参数与展示结果，算法全在这里。
 *
 * 协议（stdin 传 JSON，stdout 回 JSON）：
 *   → {"action":"machineCode"}
 *   ← {"ok":true,"machineCode":"XXXXX-..."}
 *   → {"action":"verify","code":"...","licenseFile":"..."}
 *   ← {"ok":true,"payload":{...}} | {"ok":false,"reason":"..."}
 *   → {"action":"activate","code":"...","licenseFile":"..."}
 *   ← {"ok":true} | {"ok":false,"reason":"..."}
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getMachineCode, verifyLicense } from "./license-core";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function emit(payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(payload.ok ? 0 : 1);
}

/** 授权文件结构：保存原始授权码 + 签发信息，方便日后排查。 */
type LicenseFile = {
  code: string;
  machineCode: string;
  issuedAt: string;
  note?: string;
  activatedAt: string;
};

function readLicenseFile(path: string): LicenseFile | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LicenseFile;
    return parsed && typeof parsed.code === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    input = {};
  }

  const action = String(input.action || "");
  const licenseFile = String(input.licenseFile || "");
  const provided = String(input.code || "").trim();

  if (action === "machineCode") {
    emit({ ok: true, machineCode: await getMachineCode() });
  }

  if (action === "verify" || action === "activate") {
    const machineCode = await getMachineCode();
    // 优先用本次输入的码；没输入就读已保存的（启动时的常规校验走这条）
    const saved = licenseFile ? readLicenseFile(licenseFile) : null;
    const code = provided || saved?.code || "";

    if (!code) emit({ ok: false, reason: "NOT_ACTIVATED", machineCode, needsCode: true });

    const result = await verifyLicense(code, machineCode);
    if (!result.ok) {
      emit({ ok: false, reason: result.reason, machineCode, needsCode: true });
    }

    if (action === "activate") {
      if (!licenseFile) emit({ ok: false, reason: "缺少授权文件路径", machineCode, needsCode: true });
      try {
        mkdirSync(dirname(licenseFile), { recursive: true });
        const payload = result.payload;
        const record: LicenseFile = {
          code,
          machineCode,
          issuedAt: String(payload.issuedAt || ""),
          note: payload.note ? String(payload.note) : undefined,
          activatedAt: new Date().toISOString(),
        };
        writeFileSync(licenseFile, JSON.stringify(record, null, 2) + "\n", "utf8");
        emit({ ok: true, machineCode, activated: true, note: record.note || "" });
      } catch (error) {
        emit({
          ok: false,
          reason: `授权文件写入失败：${error instanceof Error ? error.message : String(error)}`,
          machineCode,
          needsCode: true,
        });
      }
    }

    emit({ ok: true, machineCode, note: result.payload.note || "", issuedAt: result.payload.issuedAt || "" });
  }

  emit({ ok: false, reason: `未知操作：${action || "(空)"}` });
}

await main();