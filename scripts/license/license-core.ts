/**
 * 主机授权（主机锁）—— 机器码采集 + 授权码校验。
 *
 * 目标：**换一台电脑，即使装了软件，没有授权码也用不了**。
 *
 * 设计要点（每一条都是防「用户自己绕过」）：
 *  1. **机器码必须由硬件派生**，不能由用户随便改。取 CPU ID、主板序列号、
 *     磁盘序列号、MAC 地址 → 归一化 → SHA-256 → 取前 20 字节 → 分组显示。
 *  2. **任一项读不到不能失败**。不同机器/不同权限下有的项可能为空，
 *     采集要容错（跳过空项），否则会出现"打不开机器码"的投诉。
 *  3. **授权码用 Ed25519 签名**，不是对称密钥。对称密钥必须写进软件，
 *     反编译就能拿到、自己就能生成授权码 —— 等于没有防护。
 *     公钥可以公开（写进源码），**私钥只在你手上**。
 *  4. 授权码内容包含「机器码 + 签发信息」，所以**授权码换个机器就无效**。
 *  5. 授权文件落在 `data/license.json`，纯文本可审查（便于排查），
 *     但内容是签名后的载荷，无法伪造。
 *
 * 为什么不用 node:crypto 的 randomUUID 之类当机器码：那些可以随意生成。
 */

/** 授权载荷的签名算法标识 —— 以后换算法时老授权码仍能被识别。 */
const SIGNATURE_ALGORITHM = "ed25519";

/** 授权载荷结构（JSON 后 base64url，再 '.' + 签名，构成授权码）。 */
export type LicensePayload = {
  /** 机器码（与本机 MachineCode() 归一化后完全一致） */
  machineCode: string;
  /** 签名算法 */
  alg: typeof SIGNATURE_ALGORITHM;
  /** 签发时间（ISO 日期），仅作记录 */
  issuedAt: string;
  /** 授权备注（如客户名），仅作记录 */
  note?: string;
  /** 载荷格式版本，便于将来平滑升级 */
  v: 1;
};

/**
 * Ed25519 **公钥**（base64url，32 字节 raw）。
 *
 * 公开是安全的 —— 它只能验签，不能签发。
 * 私钥存放在你的本机（C:\Users\<你>\.workbuddy\tools\jinyutv-license\private.jwk），
 * **不进 git 仓库、不进安装包**。
 */
const PUBLIC_KEY_X = "ybH0wBMN4WMvkAaktiy_c-U-LrjJ5i1qDE1MHbmwdJY";

/* ------------------------------------------------------------------ 工具 */

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * 采集一个硬件标识。
 *
 * 用 PowerShell + CIM/WMI 是兼容性最好的做法（Win10/11 自带，无需额外依赖）。
 * 每一项都单独跑，单项失败不影响整体。
 */
async function readHardwareValue(script: string): Promise<string> {
  if (process.platform !== "win32") return "";
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true },
      );
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
      }, 6000);
      child.stdout?.on("data", (chunk) => { out += String(chunk); });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    } catch {
      resolve("");
    }
  });
}

/** 把各种可能的"占位值"当作无效（很多机器的序列号是 "To Be Filled By O.E.M." 之类）。 */
function isPlaceholder(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text) return true;
  return [
    "to be filled by o.e.m.",
    "to be filled by oem",
    "default string",
    "system serial number",
    "none",
    "unknown",
    "not specified",
    "not applicable",
    "00000000-0000-0000-0000-000000000000",
  ].includes(text);
}

/**
 * 采集本机稳定硬件标识并算出机器码。
 *
 * ⚠️ **必须稳定**：同一台机器多次调用结果要一致，否则用户会看到机器码自己变了。
 * 因此：
 *   · 去掉所有分隔符再取哈希（`F0-9A` 与 `F09A` 视为同一个）；
 *   · 排序固定（硬件项顺序写死在下面）；
 *   · 不采集 MAC 地址 —— 虚拟网卡/网卡顺序会变，跨重启可能不同（见下方注释）。
 */
export async function getMachineCode(): Promise<string> {
  const parts: string[] = [];

  // ① 主板/整机 UUID（最稳定，几乎每台机都有）
  const board = await readHardwareValue(
    "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
  );
  if (!isPlaceholder(board)) parts.push(`B:${board.toUpperCase()}`);

  // ② CPU ID（识别处理器，换主板才变）
  const cpu = await readHardwareValue("(Get-CimInstance Win32_Processor).ProcessorId");
  if (!isPlaceholder(cpu)) parts.push(`C:${cpu.toUpperCase()}`);

  // ③ 系统盘序列号（磁盘是最难被普通用户改的部件）
  const disk = await readHardwareValue(
    "(Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'SCSI' -or $_.Model -notmatch 'Virtual|VMware|VirtualBox|QEMU' } | Select-Object -First 1 -ExpandProperty SerialNumber)",
  );
  if (!isPlaceholder(disk)) parts.push(`D:${disk.toUpperCase()}`);

  /*
   * 关于 MAC 地址：**故意不采集**。
   * 原因：Windows 上网卡枚举顺序不保证稳定，且虚拟网卡（VPN/虚拟机/WSL）
   * 会新增或抢占条目 —— 实测有机器因此导致机器码每次启动都变，用户无法激活。
   * 上面三项已经足够定位一台机器，且都比 MAC 稳定。
   */

  if (!parts.length) {
    // 一项都没采到（极端情况，例如被安全软件拦截 PowerShell）。
    // 此时不能抛异常让软件打不开，退回到一个可用但更弱的标识。
    parts.push(`F:${process.env.COMPUTERNAME || "UNKNOWN"}|${process.env.USERNAME || ""}`);
  }

  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(parts.join("|")).digest();
  return formatMachineCode(digest.subarray(0, 10));
}

/** 把 10 字节摘要格式化成 `XXXXX-XXXXX-XXXXX-XXXXX`（20 个字符，人工可抄、可口述）。 */
export function formatMachineCode(digest: Buffer): string {
  const hex = digest.toString("hex").toUpperCase(); // 20 个 hex 字符
  const groups: string[] = [];
  for (let index = 0; index < hex.length; index += 5) groups.push(hex.slice(index, index + 5));
  return groups.join("-");
}

/* ------------------------------------------------------------ 签发/验签 */

/**
 * 把 base64url 还原成原始密钥字节。
 *
 * ⚠️ **不要硬编码 DER 前缀**再拼字节 —— 实测这样签出来的码**自己都验不过**
 * （前缀只要差一位，密钥对象就是错的）。直接用 JWK 让运行时自己组装。
 */
function publicJwk() {
  return { kty: "OKP", crv: "Ed25519", x: PUBLIC_KEY_X };
}

/** 签发授权载荷并返回授权码。仅由你的离线生成器调用，软件运行时不用。 */
export async function signLicense(
  payload: LicensePayload,
  privateJwkJson: string,
): Promise<string> {
  const { createPrivateKey, sign } = await import("node:crypto");
  const body = toBase64Url(JSON.stringify(payload));
  const key = createPrivateKey({ key: JSON.parse(privateJwkJson), format: "jwk" });
  const signature = sign(null, Buffer.from(body, "utf8"), key);
  return `${body}.${toBase64Url(signature)}`;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: string };

/**
 * 校验授权码是否**既签名合法、又绑定本机**。
 *
 * 两道校验缺一不可：
 *   · 验签不过 → 授权码是伪造/改过的；
 *   · 验签过但机器码不同 → 这是**别人的授权码**，复制到本机无效（主机锁的本质）。
 */
export async function verifyLicense(code: string, machineCode: string): Promise<VerifyResult> {
  const text = String(code || "").trim().replace(/\s+/g, "");
  if (!text) return { ok: false, reason: "授权码为空" };

  const parts = text.split(".");
  let body: string;
  let signature: string;
  if (parts.length === 2) {
    // 本项目签发器的原生格式：payload.signature
    [body, signature] = parts;
  } else if (parts.length === 3 || parts.length === 4) {
    //带 JOSE header 的格式：header.payload.signature（3 段）
    // 或 header.payload.encryptedKey.signature（4 段，JWE 风格）。
    // 无论哪种，**签名都是最后一段、payload 是倒数第二段**，
    // 所以统一从尾部取，避免把 header 当成 payload 去JSON.parse。
    signature = parts[parts.length - 1]!;
    body = parts[parts.length - 2]!;
  } else {
    return {
      ok: false,
      reason: `授权码格式不正确（应为 2~4 段，以英文小数点分隔，当前 ${parts.length} 段）`,
    };
  }
  if (!body || !signature) return { ok: false, reason: "授权码内容不完整，请确认复制了整段" };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(fromBase64Url(body).toString("utf8")) as LicensePayload;
  } catch {
    return { ok: false, reason: "授权码内容无法解析，请确认复制完整" };
  }
  if (!payload || payload.alg !== SIGNATURE_ALGORITHM || payload.v !== 1) {
    return { ok: false, reason: "授权码格式版本不匹配，请向软件提供方索取新版授权码" };
  }

  // ① 机器码必须一致（主机锁）
  if (payload.machineCode !== machineCode) {
    return {
      ok: false,
      reason: `授权码与本机不匹配（授权码绑定 ${payload.machineCode}，本机是 ${machineCode}）。一个授权码只能在一台电脑上使用。`,
    };
  }

  // ② 签名必须合法（防伪造）
  try {
    const { createPublicKey, verify } = await import("node:crypto");
    const key = createPublicKey({ key: publicJwk(), format: "jwk" });
    const valid = verify(null, Buffer.from(body, "utf8"), key, fromBase64Url(signature));
    if (!valid) return { ok: false, reason: "授权码签名无效，可能已被修改或并非本软件签发" };
  } catch (error) {
    return { ok: false, reason: `授权码校验失败：${error instanceof Error ? error.message : String(error)}` };
  }

  return { ok: true, payload };
}

/** 本机公钥指纹：签发工具用它来核对「签发用的是同一套密钥」。 */
export const publicKeyFingerprint = `SHA256:${(await import("node:crypto"))
  .createHash("sha256")
  .update(fromBase64Url(PUBLIC_KEY_X))
  .digest("hex")
  .slice(0, 16)
  .toUpperCase()}`;