/**
 * 豆包账号池 —— 对标 CDTV（JinyuTV）的账号管理。
 *
 * 为什么需要：豆包网页版按「账号」给每日免费额度，单账号很容易用满。
 * CDTV 的做法是维护一个账号池，每账号独立浏览器 profile，额度用尽自动换号。
 * 本模块把同一套能力搬到 Toonflow 侧。
 *
 * 数据落盘（不依赖沙箱，纯本地文件）：
 *   <toonflow>/data/doubao/accounts.json   账号清单
 *   ~/.toonflow-doubao-accounts/<id>/      每个账号独立的浏览器 profile
 *
 * 选号规则（与 CDTV 对齐）：
 *   1. 今天被标记「额度耗尽」的不用
 *   2. 本地计数已达每日上限的不用
 *   3. 正在被某个生成任务占用的不用
 *   4. 优先 sortOrder 小的（即用户排在前面的）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** 账号平台。历史账号没有这个字段，一律按豆包处理。 */
export type AccountType = "doubao" | "dola";

export type AccountPlatform = {
  key: AccountType;
  /** 界面显示的平台名 */
  label: string;
  /** 站点入口（登录与生成都从这里开始） */
  url: string;
  /** 主域名：登录 cookie 判定与成片地址白名单都用它 */
  domain: string;
  /** 本地保守的每日额度上限（真实上限由平台决定，这里只用于轮换） */
  dailyQuota: number;
};

/**
 * 平台表 —— 豆包（国内）与 Dola（海外）的差异只有三处：
 *   站点地址、登录态怎么判、页面控件怎么点（后两者在 doubao-rpa-core.ts 里分支）。
 * Dola 是海外站点（dola.com），与豆包同族但不同域，不能混用 cookie 与选择器。
 */
export const ACCOUNT_PLATFORMS: Record<AccountType, AccountPlatform> = {
  doubao: {
    key: "doubao",
    label: "豆包",
    url: "https://www.doubao.com/",
    domain: "doubao.com",
    dailyQuota: 3,
  },
  dola: {
    key: "dola",
    label: "Dola（海外）",
    url: "https://www.dola.com/chat",
    domain: "dola.com",
    dailyQuota: 4,
  },
};

export function normalizeAccountType(value: unknown): AccountType {
  return String(value ?? "").trim().toLowerCase() === "dola" ? "dola" : "doubao";
}

export function platformOf(account: { accountType?: string } | undefined | null): AccountPlatform {
  return ACCOUNT_PLATFORMS[normalizeAccountType(account?.accountType)];
}

export type DoubaoAccount = {
  id: string;
  name: string;
  /** 所属平台；老数据没有这个字段时按豆包处理 */
  accountType: AccountType;
  /** 该账号专属的浏览器 profile 目录 */
  profileDir: string;
  hasLoggedIn: boolean;
  /** 额度耗尽日期（YYYY-MM-DD）；当天不再选用 */
  quotaExhaustedOn: string;
  /** 计数归属日期（YYYY-MM-DD） */
  quotaUsageDate: string;
  generatedToday: number;
  /** 本地每日上限；真实上限由平台决定，这里用于保守轮换 */
  dailyQuota: number;
  sortOrder: number;
  lastUsedAt: string;
  note: string;
  /**
   * 登录态指纹（`sessionid` + `sid_tt` 的 hash）。
   *
   * 为什么需要：浏览器扩展会**反复推送**同一份登录态（豆包 cookie 一变就推一次，
   * 另有每 5 分钟兜底），若每次都 `addAccount` 就会把账号池撑爆。
   * 靠它认出「这还是同一个账号」，改成更新而不是新建。
   */
  sessionFingerprint: string;
  /**
   * 平台侧的稳定身份（豆包 user_id，如 `1234567890123456`）。
   *
   * 与 `sessionFingerprint` 的区别：指纹跟着「这一次登录」变（重新登录就换一份），
   * uid 是账号本身的身份、不会变。去重**优先用它** —— 否则用户重登一次同一账号，
   * 账号池里就会多出一个重复项。
   */
  doubaoUid: string;
};

const ACCOUNTS_FILE = resolve(process.cwd(), "data", "doubao", "accounts.json");
const PROFILE_BASE = resolve(homedir(), ".toonflow-doubao-accounts");
/** 老的单账号 profile：首次运行自动导成账号池里的第一个账号。 */
const LEGACY_PROFILE = resolve(homedir(), ".toonflow-doubao-profile");

export function today(): string {
  // 用本地时区（sv-SE 恰好是 YYYY-MM-DD），避免 UTC 跨日错判
  return new Date().toLocaleDateString("sv-SE");
}

export function profileDirFor(id: string): string {
  return resolve(PROFILE_BASE, id);
}

/** 新账号的默认名字按平台区分，避免一串账号分不清是哪个平台。 */
function defaultAccountName(accountType: AccountType, index: number): string {
  return accountType === "dola" ? `Dola 账号 ${index + 1}` : `豆包账号 ${index + 1}`;
}

function normalize(account: Partial<DoubaoAccount>, index: number): DoubaoAccount {
  const id = String(account.id || `doubao-${Date.now()}-${index}`);
  // 历史账号没有 accountType，normalizeAccountType 会归到豆包
  const accountType = normalizeAccountType((account as { accountType?: unknown }).accountType);
  const platform = ACCOUNT_PLATFORMS[accountType];
  return {
    id,
    accountType,
    name: String(account.name || defaultAccountName(accountType, index)),
    profileDir: String(account.profileDir || profileDirFor(id)),
    hasLoggedIn: Boolean(account.hasLoggedIn),
    quotaExhaustedOn: String(account.quotaExhaustedOn || ""),
    quotaUsageDate: String(account.quotaUsageDate || ""),
    generatedToday: Number(account.generatedToday || 0),
    dailyQuota: Number(account.dailyQuota || platform.dailyQuota),
    sortOrder: Number(account.sortOrder ?? index),
    lastUsedAt: String(account.lastUsedAt || ""),
    note: String(account.note || ""),
    sessionFingerprint: String((account as { sessionFingerprint?: unknown }).sessionFingerprint || ""),
    doubaoUid: String((account as { doubaoUid?: unknown }).doubaoUid || ""),
  };
}

export async function loadAccounts(): Promise<DoubaoAccount[]> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(ACCOUNTS_FILE, "utf-8"));
  } catch {
    raw = null;
  }
  const list = Array.isArray(raw) ? raw : [];
  let accounts = list.map((item, index) => normalize(item as Partial<DoubaoAccount>, index));

  // 首次运行：把老的单账号 profile 导入为第一个账号，避免用户重新扫码
  if (!accounts.length && existsSync(LEGACY_PROFILE)) {
    accounts = [
      normalize(
        {
          id: "default",
          name: "豆包账号 1（原有登录）",
          profileDir: LEGACY_PROFILE,
          hasLoggedIn: true,
          note: "由单账号模式自动迁移",
        },
        0,
      ),
    ];
    await saveAccounts(accounts);
  }
  return accounts.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function saveAccounts(accounts: DoubaoAccount[]): Promise<void> {
  await mkdir(dirname(ACCOUNTS_FILE), { recursive: true });
  await writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
}

/** 今日该账号已生成次数（跨日自动归零显示，不改存储）。 */
export function usedToday(account: DoubaoAccount): number {
  return account.quotaUsageDate === today() ? account.generatedToday : 0;
}

/** 额度是否已耗尽（本地标记或本地计数）。 */
export function quotaExhausted(account: DoubaoAccount): boolean {
  return account.quotaExhaustedOn === today() || usedToday(account) >= account.dailyQuota;
}

/** 剩余额度（-1 表示今日已标记耗尽）。 */
export function remainingQuota(account: DoubaoAccount): number {
  if (account.quotaExhaustedOn === today()) return 0;
  return Math.max(0, account.dailyQuota - usedToday(account));
}

/** 正在被占用的账号 id 集合，由服务端维护。 */
const busy = new Set<string>();

export function markBusy(id: string): void {
  busy.add(id);
}
export function releaseBusy(id: string): void {
  busy.delete(id);
}
export function isBusy(id: string): boolean {
  return busy.has(id);
}

export type PickResult = { account: DoubaoAccount } | { error: string };

/**
 * 挑一个可用账号。
 * 传 accountType 就只在那个平台的账号里挑（生成时按供应商的平台传）。
 * 全部不可用时返回带可读原因的错误，直接展示到画布节点的错误里。
 */
export async function pickAccount(accountType?: AccountType): Promise<PickResult> {
  const all = await loadAccounts();
  if (!all.length) return { error: "还没有账号，请先在设置 → 媒体供应商里新增账号并扫码登录" };

  const wanted = accountType ? all.filter((a) => a.accountType === accountType) : all;
  if (accountType && !wanted.length) {
    return { error: `还没有 ${ACCOUNT_PLATFORMS[accountType].label} 账号，请先新增并完成登录` };
  }

  const usable = wanted.filter((a) => !quotaExhausted(a) && !isBusy(a.id));
  if (usable.length) return { account: usable[0] };

  const busyCount = wanted.filter((a) => isBusy(a.id)).length;
  const exhausted = wanted.filter((a) => quotaExhausted(a)).length;
  if (busyCount && busyCount === wanted.length) {
    return { error: "所有账号都在生成中，请等其中一个任务完成后再试" };
  }
  return {
    error: `全部 ${wanted.length} 个账号的今日额度都已用完（${exhausted} 个），请新增账号后在设置里完成登录`,
  };
}

/** 生成成功后：计数 +1。 */
export async function recordSuccess(id: string): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  const day = today();
  if (account.quotaUsageDate !== day) {
    account.quotaUsageDate = day;
    account.generatedToday = 0;
  }
  account.generatedToday += 1;
  account.lastUsedAt = new Date().toISOString();
  await saveAccounts(accounts);
}

/** 豆包明确报「额度不足」时：标记当天耗尽，后续不再选用该账号。 */
export async function markQuotaExhausted(id: string): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.quotaExhaustedOn = today();
  account.lastUsedAt = new Date().toISOString();
  await saveAccounts(accounts);
}

export async function addAccount(name?: string, accountType: AccountType = "doubao"): Promise<DoubaoAccount> {
  const accounts = await loadAccounts();
  const type = normalizeAccountType(accountType);
  // id 前缀按平台区分，profile 目录名一眼能看出是哪个平台
  const id = `${type === "dola" ? "dola" : "doubao"}-${Date.now().toString(36)}`;
  const account = normalize(
    {
      id,
      accountType: type,
      name: name?.trim() || defaultAccountName(type, accounts.filter((a) => a.accountType === type).length),
      profileDir: profileDirFor(id),
      hasLoggedIn: false,
      dailyQuota: ACCOUNT_PLATFORMS[type].dailyQuota,
      sortOrder: accounts.length,
    },
    accounts.length,
  );
  accounts.push(account);
  await saveAccounts(accounts);
  return account;
}

export async function removeAccount(id: string): Promise<boolean> {
  const accounts = await loadAccounts();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  next.forEach((a, index) => {
    a.sortOrder = index;
  });
  await saveAccounts(next);
  return true;
}

export async function markLoggedIn(id: string, loggedIn: boolean): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.hasLoggedIn = loggedIn;
  account.quotaExhaustedOn = ""; // 重新登录视为恢复可用
  await saveAccounts(accounts);
}

/** 记下该账号对应的登录态指纹（供「同一浏览器反复推送」时去重）。 */
export async function setSessionFingerprint(id: string, fingerprint: string): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.sessionFingerprint = fingerprint;
  await saveAccounts(accounts);
}

/**
 * 记下账号在平台侧的稳定身份 + 展示名（从浏览器同步 / 扫码登录后都走它）。
 *
 * 只传想要更新的字段，其余保持原样。
 */
export async function setAccountIdentity(
  id: string,
  identity: { uid?: string; fingerprint?: string; name?: string; hasLoggedIn?: boolean },
): Promise<void> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  if (identity.uid) account.doubaoUid = identity.uid;
  if (identity.fingerprint) account.sessionFingerprint = identity.fingerprint;
  // 昵称只在真的拿到时覆盖，别用空串把用户改过的名字冲掉
  if (identity.name && identity.name.trim()) account.name = identity.name.trim();
  if (identity.hasLoggedIn !== undefined) {
    account.hasLoggedIn = identity.hasLoggedIn;
    if (identity.hasLoggedIn) account.quotaExhaustedOn = ""; // 重新登录视为恢复可用
  }
  await saveAccounts(accounts);
}

export function accountsFilePath(): string {
  return ACCOUNTS_FILE;
}
