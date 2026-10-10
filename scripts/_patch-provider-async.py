# -*- coding: utf-8 -*-
"""把 doubao provider 从「一个长请求等出片」改成「领任务号 → 长轮询取结果」。

原因见 RPA 服务里的说明：长连接会被各层超时（HTTP 默认总请求超时 300 秒、
RPA 服务 idleTimeout 上限 255 秒）掐断，导致「豆包已出片、画布拿不到结果」。
轮询方式每次请求都很短，出片后客户端下一次轮询（秒级）即可取回。
"""
import pathlib

TARGETS = [
    "packages/providers/src/media/doubaoAccount.ts",
    "data/providers/doubaoAccount.ts",
    "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/JinyuTV-portable/data/providers/doubaoAccount.ts",
]

OLD = '''    let response;
    try {
      response = await this.tool.fetch(base + "/generate", {
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("无法连接本地 RPA 服务（" + base + "）：" + detail + "。请先执行 bun run scripts/doubao-rpa-service.ts");
    }

    const result = await response.json().catch(() => null);
    if (!result || result.ok !== true) {
      const reason = (result && result.error) || "HTTP " + response.status;
      throw new Error("豆包生成失败：" + reason);
    }

    const bytes = Buffer.from(String(result.base64 || ""), "base64");
    if (!bytes.length) throw new Error("本地 RPA 服务返回了空文件");'''

NEW = '''    // 第一步：领任务号（秒回）。
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
    if (!bytes.length) throw new Error("本地 RPA 服务返回了空文件");'''


def main():
    for rel in TARGETS:
        path = pathlib.Path(rel)
        if not path.exists():
            print("  跳过（不存在）：%s" % rel)
            continue
        text = path.read_text(encoding="utf-8")
        if OLD not in text:
            print("  ！未找到待替换片段（可能已改过）：%s" % rel)
            continue
        path.write_text(text.replace(OLD, NEW), encoding="utf-8")
        print("  ✓ %s" % rel)


if __name__ == "__main__":
    main()
