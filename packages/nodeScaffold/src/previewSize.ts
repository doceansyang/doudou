/**
 * 节点预览区（视频 / 图片）的尺寸基准。
 *
 * ── 一句话 ──
 * **短边固定 240**：横版固定高 240，竖版固定宽 240。
 *
 * ── 为什么不是「高固定 240」 ──
 * 早先的公式是 `宽 = 240 × (w / h)`，即**高度**恒为 240。后果是竖版被压成细长条：
 *   16:9 → 427×240      9:16 → **135×240**（只有横版的 1/3 宽）
 *   4:3  → 320×240      3:4  → **180×240**
 * 用户在画布上一眼就觉得「竖版那个怎么那么小」，虽然它高度并不矮。
 *
 * 改成短边固定后（等价于把横版那个框**竖起来**）：
 *   16:9 → 427×240      9:16 → 240×427
 *   4:3  → 320×240      3:4  → 240×320
 *   1:1  → 240×240
 * 互为倒数的两种比例**面积相等**，视觉上一样大 —— 这正是需求的原话。
 *
 * ⚠️ 这个值是 **JS 与 CSS 共管**的，改一边必须同步另一边，否则框比内容宽，
 *    两侧会露出播放器/容器的底色（翻成老账就是当年那回「9:16 视频两边有灰边」）：
 *      · `components/videoPlayer.vue` → `.videoPlayer{min-width}` 必须 = 本值
 *      · `components/videoPlayer.vue` → `.videoPreview{max-height}` 与
 *        `components/imageEditor.vue` → `img{max-height}` 是**极端比例兜底**，
 *        普通竖版（最高 9:16 的 427px）必须放得下，所以给了 480。
 */
export const PREVIEW_SHORT_EDGE = 240;

/**
 * 16:9 横版预览区的宽度（≈ 427）。
 *
 * 用途：**空状态**（还没生成/上传内容）时节点的默认尺寸。
 *
 * 为什么需要它：节点骨架（`nodeSkeleton.vue`）的默认宽度是 220px，各节点只在
 * 「有预览内容、且读到了元数据」时才用 `previewWidth()` 覆盖它。于是**空节点又小又挤**，
 * 与「生成出 16:9 结果之后」的样子差一大截，生成动画也被压在一个小方框里看不清。
 * 现在空状态直接按 16:9 横版的尺寸占位 —— 出图前后大小一致，动画也能铺开。
 *
 * ⚠️ 与 CSS 共管：各节点的 `.xxxContent` / `.xxxEmpty` 写了 `min-height: PREVIEW_SHORT_EDGE`，
 *    改这里要同步改那边（反之亦然）。
 */
export const PREVIEW_WIDTH_16_9 = Math.round(PREVIEW_SHORT_EDGE * 16 / 9);

/**
 * 按内容原始像素算出预览区该占多宽。
 *
 * @param width  内容原始宽（`videoWidth` / `naturalWidth`）
 * @param height 内容原始高（`videoHeight` / `naturalHeight`）
 * @returns 预览宽度（px）；宽或高为 0（元数据还没读到）时返回 0，调用方据此不设宽度
 */
export function previewWidth(width: number, height: number) {
  if (!width || !height) return 0;
  return PREVIEW_SHORT_EDGE * Math.max(1, width / height);
}
