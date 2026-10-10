import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { translateMessage, validationOptions } from "@/lib/i18n";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), mediaType: z.enum(["image", "video", "audio"]),
}), async (req, res) => {
  const { directory, mediaType, ...request } = req.body;
  const parsed = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema).safeParse(request, validationOptions());
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    return;
  }
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // 生成任务**不绑定 HTTP 连接的生命周期**。
  //
  // 豆包走的是真实浏览器，一次生成 5～10 分钟；而前端只要刷新画布、切换视图
  // 或节点组件卸载，这个连接就会断开。原实现把 close / aborted / socket close
  // 都接到 controller.abort()，结果连接一断，已经跑完的生成结果就被直接丢弃：
  // RPA 是独立进程，它照旧跑完并落盘，但 JinyuTV 这边不归档、不写回节点
  // （实测踩过：生成 311 秒的成片只留在 RPA 目录，画布节点却是空的）。
  //
  // 因此这里只记录断开，不中断生成 —— 结果照常写进工作区，节点可从「媒体历史」找回。
  let clientGone = false;
  const noteClose = () => { clientGone = true; };
  const controller = new AbortController();
  res.once("close", noteClose);
  req.once("aborted", noteClose);
  req.socket.once("close", noteClose);
  try {
    const files = await u.mediaGeneration.generateMedia(cwd, mediaType, parsed.data, controller.signal);
    if (!res.destroyed) res.json(success(files));
    else if (clientGone) console.log(`[媒体生成] 客户端已断开，生成结果仍已写入工作区：${files.map(file => file.path).join(", ")}`);
  } finally {
    res.off("close", noteClose);
    req.off("aborted", noteClose);
    req.socket.off("close", noteClose);
  }
});
