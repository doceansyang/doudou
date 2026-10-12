// 干跑：用真实适配器 + mock fetch，打印「Linke 节点这次会发给网关的请求体」。
// 不产生任何真实网络请求，不花钱。
// 运行：bun run --cwd apps/server ../../toonflow/packages/providers/scripts/_dryrun.ts
/// <reference path="../types.d.ts" />
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { mkdtemp, readFile, rm } = await import(require.resolve("@toonflow/file"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toonflowDryrun"));
const originalDataDirectory = process.env.TOONFLOW_DATA_DIR;
process.env.TOONFLOW_DATA_DIR = temporaryDirectory;
const originalFetch = globalThis.fetch;

try {
  const { loadMediaProviderSource } = await import("../../../apps/server/src/utils/media/provider");
  const source = await readFile(new URL("../src/media/JinyuDream.ts", import.meta.url), "utf8");

  const sent: { method: string; host: string; path: string; body: unknown; form?: string }[] = [];
  let call = 0;
  const mockFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    // 两条链路：api.linke.link（new-api）与 toapis.cn（带参考素材时直连）。
    const direct = url.hostname.includes("toapis");
    // 素材上传走的是 multipart（适配器手写的 body，不是 FormData），不能 JSON.parse。
    const contentType = String((init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "");
    const isForm = contentType.includes("multipart/form-data");
    sent.push({
      method: String(init?.method ?? "GET"),
      host: url.hostname,
      path,
      body: isForm ? null : (init?.body ? JSON.parse(String(init.body)) : null),
      form: isForm ? "file" : undefined,
    });
    // 上传端点（toapis）自成一个响应形状：{success, data:{url}}。
    if (path.startsWith("/v1/uploads/")) {
      return Response.json({
        success: true,
        message: "",
        data: { id: "upload_dryrun", url: `https://files.toapis.cn/uploads/mock${path.replace("/v1/uploads/", "/")}`, mime_type: "image/png", size: 12 },
      });
    }
    if (direct) {
      // toapis 原生协议：提交返回 {id,status:"pending"}；查询返回顶层 status + result.data[].url
      if (String(init?.method ?? "GET") === "POST") {
        return Response.json({ id: "tsk_dryrun", object: "generation.task", model: "mock", status: "pending" });
      }
      return Response.json({ id: "tsk_dryrun", status: "completed", result: { type: "image", data: [{ url: "https://files.toapis.cn/dryrun/out.png" }] } });
    }
    call++;
    // linke（new-api）协议：第一次提交拿 task_id，第二次给终态
    if (call === 1) return Response.json({ task_id: "task_dryrun", status: "queued" });
    return Response.json({ code: "success", data: { status: "SUCCESS", result_url: "https://mock.invalid/out.mp4" } });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;

  // 带上「素材上传密钥」：本地素材在「不收 base64」的模型上会先上传到 toapis 换公网 URL。
  const provider = await loadMediaProviderSource(source, { apiKey: "mockKey", uploadApiKey: "mockUploadKey" }, undefined, mockFetch);

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
  // 完全照画布里 a658546f 那个节点的实际存值：
  //   model=["JinyuDream","seedance-2-mini"] duration=5 resolution=720p ratio=4:3
  //   mode='["imageReference:9","videoReference:3","audioReference:3"]'
  // ⚠️ 参考素材：**本地文件在多数模型上不被接受**（上游只收公网 URL，见 referenceUrl 的说明）；
  //    软件的做法是先用配置里的 toapis 上传递钥把本地素材换成公网 URL 再发。这里用公网 URL，
  //    是为了先看清「三家视频模型各自的字段名」，上传路径见下方专门的用例。
  await provider.generateVideo!({
    model: "seedance-2-mini",
    prompt: "按照关联文本节点【不怕，有哥在】生成。小花形象参考，大军及衣服鸭子图案参考，家中夜晚卧室参考，小花音色",
    duration: 5,
    resolution: "720p",
    ratio: "4:3",
    mode: ["imageReference:9", "videoReference:3", "audioReference:3"] as never,
    generateAudio: true,
    images: [
      { type: "url", url: "https://example.com/hua.png" },
      { type: "url", url: "https://example.com/dajun.png" },
    ],
    videos: [{ type: "url", url: "https://example.com/prev.mp4" }],
    audios: [{ type: "url", url: "https://example.com/voice.mp3" }],
  });

  console.log("=== 真实适配器发出的请求 ===");
  for (const s of sent) {
    const body = s.body === null ? "(无)" : JSON.stringify(s.body, null, 1);
    // base64 太长，截断显示
    console.log(`${s.method} ${s.host}${s.path}`);
    console.log(body.length > 1400 ? body.slice(0, 1400) + "\n  …（截断）" : body);
    console.log();
  }

  // 第二个用例：图片。必须走**任务端点**（见适配器里的实测说明）；
  // 注意 `size` 是**宽高比**、`resolution` 才是档位（曾经写成 1024x1024 导致一律"无可用渠道"）。
  sent.length = 0;
  await provider.generateImage!({
    model: "gpt-image-2",
    prompt: "生成一张电影画报",
    size: "2K",
    ratio: "3:2",
  });
  console.log("=== 图片请求（应走 video/generations；size=比例、resolution=档位）===");
  for (const s of sent) {
    console.log(`${s.method} ${s.host}${s.path}`);
    console.log(JSON.stringify(s.body, null, 1));
    console.log();
  }

  // 第四个用例：4K 不支持 1:1，应在**本地**就被拦下（不发请求、不花钱）。
  sent.length = 0;
  console.log("=== 4K + 不支持的 1:1 应被本地拦下 ===");
  try {
    await provider.generateImage!({ model: "gpt-image-2", prompt: "x", size: "4K", ratio: "1:1" });
    console.log("  ✗ 没有被拦下（回归）");
  } catch (error) {
    console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
    console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
  }

  // 第五个用例：**三家视频模型的字段名各不相同**，逐个打出来对照官方文档。
  //   seedance → aspect_ratio + image_with_roles + generate_audio（上面第一个用例）
  //   wan3.0   → ratio + reference_images + audio + watermark
  //   grok     → aspect_ratio + **单张 image**（支持文生视频与图生视频，没有音频字段）
  sent.length = 0;
  await provider.generateVideo!({
    model: "wan3.0-video", prompt: "x", duration: 30, resolution: "1080p", ratio: "adaptive",
    generateAudio: false,
    images: [{ type: "url", url: "https://example.com/a.png" }],
  });
  console.log("=== Wan 3.0 请求（ratio / reference_images / audio / watermark）===");
  for (const s of sent) console.log(JSON.stringify(s.body, null, 1));
  console.log();

  sent.length = 0;
  await provider.generateVideo!({
    model: "grok-video-1.5", prompt: "让这张图动起来", duration: 8, resolution: "720p", ratio: "16:9",
    generateAudio: true,
    images: [{ type: "url", url: "https://example.com/shot.png" }],
  });
  console.log("=== Grok 请求（应有 image；不应有 image_with_roles / generate_audio / audio）===");
  for (const s of sent) console.log(JSON.stringify(s.body, null, 1));
  console.log();

  sent.length = 0;
  console.log("=== Grok 纯文本（应能发出：官方明确支持文生视频）===");
  try {
    await provider.generateVideo!({ model: "grok-video-1.5", prompt: "x", duration: 8, resolution: "720p", ratio: "16:9" });
    console.log("  ✓ 已发出 " + sent.length + " 个请求（应为 1）");
    for (const s of sent) console.log("  " + JSON.stringify(s.body));
  } catch (error) {
    console.log("  ✗ 被拦下了（回归 —— grok 支持文生视频）：" + (error instanceof Error ? error.message : String(error)));
  }
  console.log();

  // 第六个用例：新接入的 GPT Image 2.5 Flare（比例集与 GPT Image 2 不同）。
  sent.length = 0;
  await provider.generateImage!({
    model: "gpt-image-2.5-flare", prompt: "x", size: "2K", ratio: "4:5",
    images: [{ type: "url", url: "https://example.com/ref.png" }],
  });
  console.log("=== GPT Image 2.5 Flare 图片请求（带参考图 → image_urls）===");
  for (const s of sent) console.log(JSON.stringify(s.body, null, 1));
  console.log();

  sent.length = 0;
  console.log("=== 2.5 Flare 选它没有的 2:1 应被本地拦下 ===");
  try {
    await provider.generateImage!({ model: "gpt-image-2.5-flare", prompt: "x", size: "1K", ratio: "2:1" });
    console.log("  ✗ 没有被拦下（回归）");
  } catch (error) {
    console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
  }
  console.log();

  // 本地素材：**只有 Seedance 系列的图片与音频**可以内嵌；其余一律要公网 URL。
  // （2026-10-12 二次更正：早先这里写的是「本地素材应内嵌成 data URL（不再拒绝）」——
  //   那是把「图片端点的一次实测」当成了链路级结论，而那次判据本身站不住：
  //   提示词把画面内容描述全了，模型不看参考图也能画出来。上游**根本不收 base64**。）
  sent.length = 0;
  console.log("=== Seedance + 本地图 → 同样先上传（本地素材一律换公网 URL）===");
  await provider.generateVideo!({
    model: "seedance-2-mini", prompt: "x", duration: 5, resolution: "720p",
    images: [{ type: "binary", data: png, mimeType: "image/png" }],
  });
  for (const s of sent) console.log(`  ${s.method} ${s.host}${s.path}` + (s.form ? `  [multipart: ${s.form}]` : ""));
  const seeded = sent.find((x) => x.method === "POST" && !x.path.startsWith("/v1/uploads/"));
  console.log("  已上传 = " + (sent.some((x) => x.path.startsWith("/v1/uploads/")) ? "✓" : "✗"));
  console.log("  发给上游的是公网 URL = " + (JSON.stringify(seeded?.body ?? "").includes("files.toapis.cn") ? "✓" : "✗"));
  console.log("  请求体里没有 data URL = " + (JSON.stringify(seeded?.body ?? "").includes("base64") ? "✗" : "✓"));
  console.log();

  sent.length = 0;
  console.log("=== Wan 3.0 + 本地图 → 应先上传到 toapis 换公网 URL，再发出去 ===");
  await provider.generateVideo!({
    model: "wan3.0-video", prompt: "x", duration: 5, resolution: "720p",
    images: [{ type: "binary", data: png, mimeType: "image/png" }],
  });
  for (const s of sent) {
    console.log(`  ${s.method} ${s.host}${s.path}` + (s.form ? `  [multipart: ${s.form}]` : ""));
    if (s.body) console.log("    " + JSON.stringify(s.body));
  }
  console.log("  上传请求已发出 = " + (sent.some(s => s.path.startsWith("/v1/uploads/")) ? "✓" : "✗"));
  const gen = sent.find((x) => x.method === "POST" && !x.path.startsWith("/v1/uploads/"));
  console.log("  生成请求发往 = " + (gen?.host ?? "?") + "，用的是公网 URL = " + (JSON.stringify(gen?.body ?? "").includes("files.toapis.cn") ? "✓" : "✗"));
  console.log();

  sent.length = 0;
  console.log("=== Seedance + 本地视频 → 同样先上传（video_with_roles 只收公网 URL）===");
  await provider.generateVideo!({
    model: "seedance-2-mini", prompt: "x", duration: 5, resolution: "720p",
    images: [{ type: "url", url: "https://example.com/a.png" }],
    videos: [{ type: "binary", data: png, mimeType: "video/mp4" }],
  });
  for (const s of sent) console.log(`  ${s.method} ${s.host}${s.path}` + (s.form ? `  [multipart: ${s.form}]` : ""));
  console.log("  上传端点 = " + (sent.find(s => s.path.startsWith("/v1/uploads/"))?.path ?? "（没有上传）"));
  console.log();

  // 没填「素材上传密钥」时，必须给出**可操作**的提示，而不是把 base64 发出去白等一场。
  const providerNoKey = await loadMediaProviderSource(source, { apiKey: "mockKey" }, undefined, mockFetch);
  sent.length = 0;
  console.log("=== 未配置上传密钥时（Wan 3.0 + 本地图）应给出可操作提示 ===");
  try {
    await providerNoKey.generateVideo!({
      model: "wan3.0-video", prompt: "x", duration: 5, resolution: "720p",
      images: [{ type: "binary", data: png, mimeType: "image/png" }],
    });
    console.log("  ✗ 没有报错（回归）");
  } catch (error) {
    console.log("  ✓ " + (error instanceof Error ? error.message : String(error)));
    console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
  }
  console.log();

  // 超大素材（> 10 MB）仍然要在**本地**拦下：与其发出去换一个含混的超时/413，不如立刻说清楚。
  sent.length = 0;
  console.log("=== 超大本地素材（>10MB）应在本地拦下 ===");
  try {
    await provider.generateVideo!({
      model: "seedance-2-mini", prompt: "x", duration: 5, resolution: "720p",
      images: [{ type: "binary", data: new Uint8Array(11 * 1024 * 1024), mimeType: "image/png" }],
    });
    console.log("  ✗ 没有被拦下（回归）");
  } catch (error) {
    console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
    console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
  }
  // ── 首尾帧 vs 参考图（2026-10-12：官方两条硬约束，本次修的正是这段）────────────
  //   ① role 只有 first_frame / last_frame / reference_image 三个合法值，
  //      首尾帧各最多一张；
  //   ② 「首尾帧模式与参考素材模式互斥」—— 同一请求不能既给首尾帧又给参考图。
  //   ⚠️ 修复前：首/尾帧被并进参考图数组、统一用 `reference_image` 发出去
  //      （wan 侧更糟：直接塞进 `reference_images`）⇒ 首帧被降级成普通参考图，
  //      wan 侧还撞上"混用"的硬报错。
  sent.length = 0;
  await provider.generateVideo!({
    model: "seedance-2-mini", prompt: "从首帧过渡到尾帧", duration: 5, resolution: "720p", ratio: "16:9",
    mode: "startEndRequired" as never,
    firstFrame: { type: "url", url: "https://example.com/first.png" },
    lastFrame: { type: "url", url: "https://example.com/last.png" },
  });
  console.log("=== Seedance 首尾帧（应 role=first_frame/last_frame；ratio 应为 adaptive）===");
  for (const s of sent) console.log(JSON.stringify(s.body, null, 1));
  console.log();

  sent.length = 0;
  await provider.generateVideo!({
    model: "wan3.0-video", prompt: "从首帧过渡到尾帧", duration: 5, resolution: "720p", ratio: "16:9",
    mode: "startEndRequired" as never,
    firstFrame: { type: "url", url: "https://example.com/first.png" },
    lastFrame: { type: "url", url: "https://example.com/last.png" },
  });
  console.log("=== Wan 3.0 首尾帧（应走 image_with_roles + 角色；**不应**出现 reference_images）===");
  for (const s of sent) console.log(JSON.stringify(s.body, null, 1));
  console.log();

  // 只给尾帧：seedance 允许（节点的「首帧可选」单图时就是这种形状），wan 明确不允许。
  sent.length = 0;
  console.log("=== Wan 3.0 只给尾帧（官方不允许）应在本地拦下 ===");
  try {
    await provider.generateVideo!({
      model: "wan3.0-video", prompt: "x", duration: 5, resolution: "720p",
      mode: "startFrameOptional" as never,
      lastFrame: { type: "url", url: "https://example.com/last.png" },
    });
    console.log("  ✗ 没有被拦下（回归）");
  } catch (error) {
    console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
    console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
  }
  console.log();

  // 首尾帧 + 参考图同时给 = 上游明令互斥，必须本地拦下（绝不静默丢素材）。
  sent.length = 0;
  console.log("=== 首尾帧 + 参考图同时给（互斥）应在本地拦下 ===");
  try {
    await provider.generateVideo!({
      model: "seedance-2-mini", prompt: "x", duration: 5, resolution: "720p",
      mode: "startEndRequired" as never,
      firstFrame: { type: "url", url: "https://example.com/first.png" },
      images: [{ type: "url", url: "https://example.com/ref.png" }],
    });
    console.log("  ✗ 没有被拦下（回归）");
  } catch (error) {
    console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
    console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
  }
  console.log();

  // 参考音频 / 视频**不能单独提交**（官方：至少要有 1 张参考图）。
  for (const [label, extra] of [
    ["只有参考音频", { audios: [{ type: "url" as const, url: "https://example.com/v.mp3" }] }],
    ["只有参考视频", { videos: [{ type: "url" as const, url: "https://example.com/v.mp4" }] }],
  ] as const) {
    sent.length = 0;
    console.log(`=== ${label}、没有参考图（官方要求至少 1 张图）应在本地拦下 ===`);
    try {
      await provider.generateVideo!({
        model: "seedance-2-mini", prompt: "x", duration: 5, resolution: "720p", ...extra,
      });
      console.log("  ✗ 没有被拦下（回归）");
    } catch (error) {
      console.log("  ✓ 已拦下：" + (error instanceof Error ? error.message : String(error)));
      console.log("  实际发出的请求数：" + sent.length + "（应为 0）");
    }
    console.log();
  }

  // ── 上报文案：上游错误必须翻成人话，且把「哪条链路 + 发了什么」附上 ────────────
  //   `fail_to_fetch_task` 这一族网关把内层原因塞成**一个 JSON 字符串**，
  //   不拆开的话用户在界面上只能看到一串带转义的 JSON。真人门禁那条尤其重要 ——
  //   它不是参数错、重试无用，只能换参考图（指纹与参考实现灵雀 ai_gateway 一致）。
  {
    const realPersonBody = {
      code: "fail_to_fetch_task",
      message: JSON.stringify({
        request_id: "167c0805-d44d-4f5c-8b8f-d4c628a18b81",
        code: "InvalidParameter.ImageFormat",
        message: "The request failed because the input image 'content[1]' may contain real person.",
      }),
      data: null,
    };
    const failingFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/uploads/")) {
        return Response.json({ success: true, message: "", data: { id: "u", url: "https://files.toapis.cn/uploads/x.png", mime_type: "image/png", size: 1 } });
      }
      return Response.json(realPersonBody, { status: 400 });
    }) as typeof fetch;
    Object.assign(failingFetch, { preconnect: originalFetch.preconnect });
    const failing = await loadMediaProviderSource(source, { apiKey: "mockKey", uploadApiKey: "mockUploadKey" }, undefined, failingFetch);
    console.log("=== 上游回 fail_to_fetch_task（含真人门禁）时的上报文案 ===");
    try {
      await failing.generateVideo!({
        model: "wan3.0-video", prompt: "x", duration: 5, resolution: "720p",
        images: [{ type: "url", url: "https://example.com/person.png" }],
      });
      console.log("  ✗ 没有报错（回归）");
    } catch (error) {
      console.log("  " + (error instanceof Error ? error.message : String(error)));
    }
    console.log();
  }

  const wavUsed = wav; // 保留变量以免被「未使用」清理
  void wavUsed;
} finally {
  globalThis.fetch = originalFetch;
  if (originalDataDirectory === undefined) delete process.env.TOONFLOW_DATA_DIR;
  else process.env.TOONFLOW_DATA_DIR = originalDataDirectory;
  assertPath();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
function assertPath() {
  if (!resolve(temporaryDirectory).startsWith(`${resolve(tmpdir())}${sep}toonflowDryrun`)) throw new Error("临时目录异常");
}
process.exit(0);
