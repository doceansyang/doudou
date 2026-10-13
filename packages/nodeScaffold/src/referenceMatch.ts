/**
 * 把提示词里手写的 `@` 按它前面的描述文字匹配到上游参考素材。
 *
 * ## 为什么需要
 * 用户会把上游图片/音频节点改名成素材名（如「小花形象」「小花音色」），并在提示词里写成
 * 「小花形象参考@，大军及衣服鸭子图案参考@，小花音色参考@」这样的占位文本。点一次
 * 「匹配元素」就能把这些 `@` 换成对应的参考标签，不用逐个打 @ 再从候选里挑。
 *
 * ## 匹配规则
 * - 每个 `@` 取**它前面那一段描述文字**（到上一个 `@`、换行或文本开头为止）。
 * - 素材名是这段文字的**子串**即算命中；多个命中时取**最长的名字**，
 *   避免「小花」抢走「小花形象」。
 * - **一对一**：一个素材最多被认领一次，靠前的 `@` 优先。
 *
 * ## ⚠️ 编号语义不得改动
 * `mentions[i].value` 形如 `{{ref N}}`，N 与 refList 下标严格绑定 —— 下游
 * `applyReferenceTags()`（换成「图片N / 音频N」）与 `startGeneration` 收集素材的顺序都依赖它。
 * 本函数只决定「哪个 @ 用哪个 N」，**绝不重排编号、绝不改写 value**。
 */
export type ReferenceMention = { name: string; value: string };

type Candidate = { index: number; name: string; value: string };
type CandidateHit = Candidate & { at: number };

export function matchReferenceMentions(text: string, mentions: readonly ReferenceMention[]): { text: string; matched: number; unmatched: string[] } {
  if (!text.includes("@")) return { text, matched: 0, unmatched: [] };
  const candidates = mentions
    .map((mention, index): Candidate => ({ index, name: mention.name?.trim() ?? "", value: mention.value }))
    .filter((item) => item.name);
  if (!candidates.length) return { text, matched: 0, unmatched: [] };
  const used = new Set<number>();
  const unmatched: string[] = [];
  let result = "";
  let segmentStart = 0;
  let matched = 0;

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\n") {
      result += text.slice(segmentStart, cursor + 1);
      segmentStart = cursor + 1;
      continue;
    }
    if (char !== "@") continue;
    const segment = text.slice(segmentStart, cursor);
    const hit = pickCandidate(segment, candidates, used);
    if (hit) {
      used.add(hit.index);
      result += segment + hit.value;
      matched += 1;
    } else {
      result += text.slice(segmentStart, cursor + 1);
      const description = cleanDescription(segment);
      if (description) unmatched.push(description);
    }
    segmentStart = cursor + 1;
  }
  result += text.slice(segmentStart);
  return { text: matched ? result : text, matched, unmatched };
}

function pickCandidate(segment: string, candidates: readonly Candidate[], used: ReadonlySet<number>) {
  let best: CandidateHit | undefined;
  for (const candidate of candidates) {
    if (used.has(candidate.index)) continue;
    const at = segment.lastIndexOf(candidate.name);
    if (at < 0) continue;
    if (!best || candidate.name.length > best.name.length || (candidate.name.length === best.name.length && at > best.at)) {
      best = { ...candidate, at };
    }
  }
  return best;
}

// 提示片段两侧的空白与标点不算描述文字，去掉后更好读。
const boundaryChars = " \t\r\n，。、；：,.;:!！?？“”\"‘’()（）【】[]<>《》";

function cleanDescription(segment: string) {
  let start = 0;
  let end = segment.length;
  while (start < end && boundaryChars.includes(segment[start]!)) start += 1;
  while (end > start && boundaryChars.includes(segment[end - 1]!)) end -= 1;
  return segment.slice(start, end);
}
