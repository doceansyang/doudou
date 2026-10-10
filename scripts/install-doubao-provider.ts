/**
 * 把豆包供应商源码装进 Toonflow。
 *
 * 已安装时 add 会返回 409；此时先用 delete（要带 revision）移除，再重新 add，
 * 这样 provider 源码才能被覆盖。
 *
 * 用法：bun run scripts/install-doubao-provider.ts
 */
const BASE = "http://127.0.0.1:3000";
const SOURCE = "packages/providers/src/media/doubaoAccount.ts";
const FILE_NAME = "doubaoAccount.ts";
const LABEL = "豆包账号（免费额度）";

async function list() {
  const data = await fetch(`${BASE}/api/providers/media/list`).then((res) => res.json());
  return data?.data ?? data ?? [];
}

const source = await Bun.file(SOURCE).text();

let providers = await list();
let existing = providers.find((p: any) => p.id === "doubaoAccount" || p.label === LABEL);

if (existing) {
  if (!existing.revision || !/^[a-f0-9]{64}$/.test(existing.revision)) {
    console.error("拿不到有效 revision，无法覆盖：", existing.revision);
    process.exit(1);
  }
  const removed = await fetch(`${BASE}/api/providers/media/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: existing.fileName || FILE_NAME, revision: existing.revision }),
  });
  console.log("删除旧版本: HTTP", removed.status, (await removed.text()).slice(0, 200));
}

const added = await fetch(`${BASE}/api/providers/media/add`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source }),
});
console.log("安装: HTTP", added.status, (await added.text()).slice(0, 400));

providers = await list();
console.log("\n当前供应商：");
for (const provider of providers) {
  console.log(
    "  -", provider.id, "|", provider.label,
    "| models:", (provider.models || []).length,
    provider.loadError ? `| 错误: ${provider.loadError}` : "",
  );
}
