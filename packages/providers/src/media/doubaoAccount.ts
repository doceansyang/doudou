/**
 * 豆包账号（免费额度）—— JinyuTV 供应商（薄转发层）。
 *
 * 为什么这里没有任何 import：
 * JinyuTV 的供应商运行在 `node:vm` 沙箱里，沙箱 linker 会直接拒绝一切模块导入
 * （`apps/server/src/utils/media/provider.ts` 的 `rejectImport` 抛「供应商不能导入模块」），
 * 且沙箱上下文里没有 fs / path / os / process，也没有 playwright。
 * 供应商能用的只有宿主注入的 `this.tool`（fetch / hash / errorMessage / image / audio / ffmpeg）。
 *
 * 所以浏览器自动化放在本地 RPA 服务里（scripts/doubao-rpa-core.ts + doubao-rpa-service.ts），
 * 本文件只负责「发一次 HTTP，把成片字节带回来」。
 *
 * 安装/更新：`bun run scripts/install-doubao-provider.ts`
 * 启动 RPA ：`bun run scripts/doubao-rpa-service.ts`
 */

export default {
  id: "doubaoAccount",
  label: "豆包账号（免费额度）",
  version: "1.3.2",
  readme: "## 豆包账号（免费额度）\n\n用你自己的豆包账号，通过浏览器自动化操作豆包网页版生成视频，消耗账号每日免费额度，不额外付费。\n\n### 前置条件（重要）\n1. **先启动本地 RPA 服务**：在 JinyuTV 目录执行 `bun run scripts/doubao-rpa-service.ts`。\n   浏览器自动化必须在沙箱之外运行，本供应商只负责转发请求。\n2. 本机需已安装 Chrome 或 Edge（Windows 10/11 自带 Edge，无需额外安装）。\n3. 首次使用需扫码登录一次（见下方「扫码登录」）。\n\n### 扫码登录\n在 JinyuTV 目录执行 `bun run scripts/doubao-rpa-service.ts --login`，在弹出窗口里扫码即可；\n登录态保存在本机，之后无需重复登录。\n\n### 注意事项\n- 生成时会打开一个真实 Chrome 窗口（在屏幕内，可随时查看）；需要扫码或人工验证时窗口会自动置顶。\n- 每日免费额度有限（通常 3～5 条 10 秒视频），耗尽时会有明确提示。\n- 一次生成约 2～3 分钟；同一时刻只能跑一个生成任务。\n- **参考素材只支持图片**（最多 4 张）。若节点上连了参考视频或音频，点生成会**明确报错**并提示你断开这些连线 —— 豆包网页版的上传控件只接受图片，不会静默忽略。",
  rules: [
    {
      type: "input",
      field: "manageUrl",
      title: "豆包账号管理（新增账号 / 查看剩余额度）",
      value: "http://127.0.0.1:18077/",
      props: { placeholder: "在浏览器打开此地址即可新增账号" },
    },
    {
      type: "input",
      field: "rpaUrl",
      title: "本地 RPA 服务地址",
      value: "http://127.0.0.1:18077",
      props: { placeholder: "http://127.0.0.1:18077" },
    },
  ],
  // mode / audio / durationResolutionMap 是画布「视频生成节点」渲染参数面板的依据，
  // 缺了它们节点上不会出现「生成模式」「时长」「分辨率」，看起来就像没接上。
  //   mode: "text" 表示纯文本；数组表示可带参考素材（图 1～4 张、视频/音频各 3 个）。
  //   注意：豆包网页版的参考素材只接受图片（上传控件 accept 仅 jpg/png/webp/apng），
  //   视频与音频参考**不支持**（会在 generateVideo 里明确报错）。
  //   之所以仍然声明进来：否则节点只要连了音频/视频素材，就会判定
  //   「没有适合这些参考素材的生成模式」而直接挡住用户 —— 那句提示太笼统，
  //   不如让人先点下去，再收到一句说清「哪个参考不支持、怎么办」的错误。
  //   audio: false —— 豆包成片自带音轨，但网页不提供开关，故不显示该项。
  //   durationResolutionMap: 豆包底栏可选时长（默认 10 秒档）。
  models: [
    {
      id: "Seedance 2.0 Fast",
      label: "豆包 Seedance 2.0 Fast（免费）",
      type: "video",
      mode: ["text", ["imageReference:4", "videoReference:3", "audioReference:3"]],
      audio: false,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "Seedance 2.0 Mini",
      label: "豆包 Seedance 2.0 Mini（免费）",
      type: "video",
      mode: ["text", ["imageReference:4", "videoReference:3", "audioReference:3"]],
      audio: false,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "Seedance 2.0",
      label: "豆包 Seedance 2.0（免费）",
      type: "video",
      mode: ["text", ["imageReference:4", "videoReference:3", "audioReference:3"]],
      audio: false,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
  ],
  generateVideo: async function (request) {
    // 豆包网页版只支持「文本 + 图片参考」，音频/视频参考一律不认。
    //
    // 这里必须**明确报错**而不是静默丢掉：静默忽略会让用户以为参考生效了，
    // 出来的片子跟预期不符，反而更难排查。所以宁可让本次生成直接失败并说清原因。
    // 放在请求之前判断，用户点一下就能看到，不用等 3 分钟。
    const audioCount = Array.isArray(request.audios) ? request.audios.length : 0;
    const videoCount = Array.isArray(request.videos) ? request.videos.length : 0;
    if (audioCount || videoCount) {
      const parts = [];
      if (videoCount) parts.push(videoCount + " 个视频参考");
      if (audioCount) parts.push(audioCount + " 个音频参考");
      throw new Error(
        "豆包免费模型不支持音频/视频参考（检测到 " + parts.join("、") + "）。" +
        "豆包网页版只能按「文本 + 图片」生成 —— 请断开节点上的这些连线后重试，" +
        "或改用支持音视频参考的付费模型（如 Seedance-2.5 支持真人）。",
      );
    }

    const raw = this.config && this.config.rpaUrl ? this.config.rpaUrl : "http://127.0.0.1:18077";
    const base = String(raw).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("本地 RPA 服务地址无效，请到「设置 → 媒体模型」检查");

    // 参考图归一化：沙箱里只有 Buffer；binary 必须先转 base64 才能走 JSON。
    const images = [];
    const pushImage = (item) => {
      if (!item || typeof item !== "object") return;
      if (item.type === "binary" && item.data) {
        images.push({ type: "base64", data: Buffer.from(item.data).toString("base64"), mimeType: item.mimeType || "image/png" });
        return;
      }
      if (item.type === "base64" && item.data) {
        images.push({ type: "base64", data: String(item.data), mimeType: item.mimeType || "image/png" });
        return;
      }
      if (item.url) images.push({ type: "url", url: String(item.url) });
    };
    if (request.images && request.images.length) request.images.forEach(pushImage);
    pushImage(request.firstFrame);
    pushImage(request.lastFrame);

    // 第一步：领任务号（秒回）。
    // 出片是分钟级任务，绝不能挂在长连接上等 —— HTTP 默认总请求超时 300 秒、
    // RPA 服务 idleTimeout 上限 255 秒，任何一层掐断都会变成「豆包已出片、画布拿不到」。
    let jobId = "";
    try {
      const started = await this.tool.fetch(base + "/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: String(request.model || "Seedance 2.0 Fast"),
          prompt: String(request.prompt || ""),
          images: images,
          ratio: request.ratio ? String(request.ratio) : undefined,
          duration: request.duration ? Number(request.duration) : undefined,
        }),
        signal: this.signal,
      });
      const meta = await started.json().catch(() => null);
      if (!meta || meta.ok !== true) throw new Error((meta && meta.error) || "HTTP " + started.status);
      jobId = String(meta.jobId || "");
      if (!jobId) throw new Error("本地 RPA 服务未返回任务号");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("无法连接本地 RPA 服务（" + base + "）：" + detail + "。请先执行 bun run scripts/doubao-rpa-service.ts");
    }

    // 第二步：长轮询取结果。每次请求最多挂 20 秒，出片后立即返回，
    // 因此不再依赖「单连接存活好几分钟」的能力，也不会被超时掐断。
    let result: any = null;
    for (let attempt = 0; attempt < 200 && !result; attempt += 1) {
      let body: any = null;
      try {
        const res = await this.tool.fetch(
          base + "/generate/result?id=" + encodeURIComponent(jobId) + "&wait=20",
          { signal: this.signal },
        );
        body = await res.json().catch(() => null);
      } catch (error) {
        if (this.signal && this.signal.aborted) throw new Error("生成已取消");
        body = null; // 偶发网络抖动：继续轮询
      }
      if (!body) continue;
      if (body.state === "running") continue;
      if (body.ok !== true) throw new Error("豆包生成失败：" + (body.error || "未知原因"));
      result = body;
    }
    if (!result) throw new Error("豆包生成超时（等待超过约 1 小时），请稍后重试");

    const bytes = Buffer.from(String(result.base64 || ""), "base64");
    if (!bytes.length) throw new Error("本地 RPA 服务返回了空文件");

    return [
      {
        mediaType: "video",
        type: "binary",
        data: bytes,
        mimeType: result.mimeType || "video/mp4",
      },
    ];
  },
};
