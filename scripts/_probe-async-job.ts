/**
 * 验证「异步任务 + 长轮询」链路：豆包一出片，客户端能否立刻取回。
 *
 * 用法：
 *   bun scripts/_probe-async-job.ts            # 短测（8 秒）
 *   bun scripts/_probe-async-job.ts 320000     # 长测（5.3 分钟，跨过旧的 300 秒超时线）
 *
 * 需要 RPA 服务以 DOUBAO_RPA_SELFTEST=1 启动（自测模式才会接 selftestSleepMs）。
 */
const BASE = "http://127.0.0.1:18077";
const sleepMs = Number(process.argv[2] || 8000);

const t0 = Date.now();

// 1) 领任务号：必须秒回（这正是修复的关键 —— 请求不再长时间挂着）
const startRes = await fetch(`${BASE}/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "(selftest)", selftestSleepMs: sleepMs }),
});
const started: any = await startRes.json();
const startElapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(`① 领任务号: ok=${started.ok} jobId=${started.jobId}  耗时 ${startElapsed}s`);
if (!started.ok || !started.jobId) {
  console.log("❌ 失败：未拿到任务号", JSON.stringify(started));
  process.exit(1);
}
if (Number(startElapsed) > 5) {
  console.log("❌ 领任务号不该阻塞这么久（说明仍是同步等待）");
  process.exit(1);
}

// 2) 长轮询取结果：记录第一次探到 done 的时刻
let polls = 0;
let result: any = null;
while (!result) {
  polls += 1;
  const res = await fetch(`${BASE}/generate/result?id=${started.jobId}&wait=20`);
  const body: any = await res.json().catch(() => null);
  if (!body) continue;
  if (body.state === "running") {
    console.log(`   轮询 #${polls}：仍在生成（已 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    continue;
  }
  result = body;
}

const total = ((Date.now() - t0) / 1000).toFixed(1);
const payload = Buffer.from(String(result.base64 || ""), "base64").toString("utf-8");

console.log(`② 取回结果: ok=${result.ok} state=${result.state}`);
console.log(`   总耗时 ${total}s（设定 ${sleepMs / 1000}s，轮询 ${polls} 次）`);
console.log(`   内容 = ${JSON.stringify(payload)}`);
console.log(`   超出旧 300 秒上限: ${Number(total) > 300 ? "是（本次正是关键验证）" : "否"}`);

const ok = result.ok === true && payload === "selftest-mp4";
console.log(ok ? "✓ 链路正常：出片即可取回，不受长连接超时影响" : "❌ 结果不符合预期");
process.exit(ok ? 0 : 1);
