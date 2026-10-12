/**
 * 把提示词里的 `{{ref N}}` 换成上游认识的「图片N / 视频N / 音频N」。
 *
 * ## 为什么必须换
 * `{{ref N}}` 只是**本软件输入框的占位符**（`promptInput` 把它渲染成一张缩略图小标签），
 * 服务端拿到的是**原样文本**，会把它一字不改地发给模型。而三家视频模型的官方文档都要求
 * 在提示词里用「图片1 / 视频1 / 音频1」按**各自类型**的顺序指代素材：
 *   · seedance：「需要引用参考素材时，使用"图片1 / 视频1 / 音频1"的方式指代」
 *   · wan3.0 ：「在参考生视频模式下，按照数组顺序定义 prompt 中素材引用的顺序…
 *                第 1 个 reference_image 对应 图 1，第 2 个对应 图 2」
 * 也就是说：用户在提示词里写 `{{ref 2}}`，模型看到的就是字面的 `{{ref 2}}`，
 * 根本不知道指的是哪张图 —— **参考图等于没被指认**。
 *
 * ## 编号规则（与上游一致：图 / 视频 / 音频**分别计数**）
 * refList 里第 1 张图 → `图片1`，第 2 张图 → `图片2`；视频、音频各自从 1 开始。
 * 文本引用（STRING）不是素材，没有对应的上游标签，**保持原样**不动。
 *
 * ⚠️ 顺序必须与 `startGeneration` 里收集素材的顺序**完全一致**：
 * 那里用的是 `refList.value.flatMap(...)` 按 `dataType` 过滤，得到的数组顺序就是
 * 本函数给它们编的号。两边一旦不一致，指代就会错位。
 */
export function applyReferenceTags(text: string, references: readonly { dataType?: string }[]) {
  if (!text || !text.includes("{{ref")) return text;
  const labels = new Map<string, string>();
  let image = 0;
  let video = 0;
  let audio = 0;
  references.forEach((item, index) => {
    if (item.dataType === "IMAGE") labels.set(`{{ref ${index + 1}}}`, `图片${++image}`);
    else if (item.dataType === "VIDEO") labels.set(`{{ref ${index + 1}}}`, `视频${++video}`);
    else if (item.dataType === "AUDIO") labels.set(`{{ref ${index + 1}}}`, `音频${++audio}`);
  });
  // 映射不到的（例如指向文本引用）保持原样 —— 宁可留着让人看见，也不要静默删掉内容。
  return text.replace(/\{\{ref (\d+)\}\}/g, (whole) => labels.get(whole) ?? whole);
}
