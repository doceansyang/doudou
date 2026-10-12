// 校验「网关模型 → 类型」的自动归类规则（apps/server/src/utils/media/modelType.ts）。
//
// 背景：网关只给 id 不给类型，而 linke 会**一直加模型** —— 这套规则决定新模型能不能
// 自动出现在正确的节点里。所以既要用**真实网关数据**验，也要用**未来可能出现的名字**验。
//
// 运行：bun run scripts/checkModelType.ts
const { inferModelType } = await import("../apps/server/src/utils/media/modelType");

type Row = { id: string; got: string; want: string; note?: string };

// ── ① 真实网关数据（没网/没 key 时跳过这一段，只看 ② 的假想用例）──
const rows: Row[] = [];
const key = process.env.LINKE_KEY ?? "";
try {
  const res = await fetch("https://api.linke.link/v1/models", {
    headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const list = (await res.json()).data as Record<string, unknown>[];
  console.log(`=== ① 真实网关数据（${list.length} 个模型）===`);
  for (const model of list) {
    const id = String(model.id);
    const got = inferModelType(id, model) ?? "(不归类 → 跳过)";
    // 期望值来自我们已知的事实：4 个视频、2 个图片、1 个文本（文本应当被跳过）
    const want = /^(gpt-image-2|gpt-image-2\.5-flare)$/.test(id) ? "image"
      : /^(seedance-2|seedance-2-mini|seedance-2-5|wan3\.0-video|grok-video-1\.5)$/.test(id) ? "video"
      : "(不归类 → 跳过)";
    rows.push({ id, got, want, note: String((model.supported_endpoint_types as string[])?.join(",") ?? "") });
  }
} catch (error) {
  console.log("（拉取真实网关失败，跳过 ①：" + (error instanceof Error ? error.message : error) + "）");
}

// ── ② 假想的"以后会加的模型"：验证启发式覆盖度 ──
console.log("\n=== ② 未来可能出现的模型名（不依赖网关，纯测规则）===");
const imagined: [string, string][] = [
  ["seedream-4", "image"],
  ["flux-2-pro", "image"],
  ["nano-banana-2", "image"],
  ["kling-v2-master", "video"],
  ["veo-3", "video"],
  ["sora-2", "video"],
  ["hailuo-03", "video"],
  ["wan2.5-video", "video"],
  ["suno-v5", "audio"],
  ["elevenlabs-multilingual-v2", "audio"],
  ["gpt-5.2", "(不归类 → 跳过)"],
  ["claude-4.5-sonnet", "(不归类 → 跳过)"],
  ["qwen3-max", "(不归类 → 跳过)"],
  ["deepseek-v4", "(不归类 → 跳过)"],
];
for (const [id, want] of imagined) {
  rows.push({ id, got: inferModelType(id, {}) ?? "(不归类 → 跳过)", want, note: "假想" });
}

// ── 输出 ──
console.log("\n模型 id".padEnd(34) + "归类结果".padEnd(20) + "期望".padEnd(20) + "判定   备注");
console.log("─".repeat(100));
let bad = 0;
for (const r of rows) {
  const ok = r.got === r.want;
  if (!ok) bad++;
  console.log(r.id.padEnd(32) + r.got.padEnd(18) + r.want.padEnd(18) + (ok ? " ✅" : " ✗ ") + "   " + (r.note ?? ""));
}
console.log("\n=== 结论 ===");
console.log(`  共 ${rows.length} 条，错 ${bad} 条 → ${bad === 0 ? "✅ 全部符合预期" : "✗ 有偏差"}`);
process.exit(0);
