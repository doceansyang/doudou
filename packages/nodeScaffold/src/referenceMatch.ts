/**
 * 把提示词里手写的 `@` 按它前面的描述文字匹配到上游参考素材。
 *
 * ## 为什么需要
 * 用户会把上游图片/音频节点改名成素材名（如「小花的形象」「小花音色」），并在提示词里写成
 * 「小花形象参考@，大军及衣服鸭子图案参考@，小花声音参考@」这样的占位文本。点一次
 * 「匹配元素」就能把这些 `@` 换成对应的参考标签，不用逐个打 @ 再从候选里挑。
 *
 * ## 匹配规则（刻意做得「活」一点，不能只盯一模一样的字）
 * 1. 每个 `@` 取**它前面那一段描述文字**（到上一个 `@`、换行或文本开头为止）。
 * 2. 归一化后比较：去掉空白、标点与「的/之/地/得」这类连接字，
 *    于是「小花的形象」与「小花形象参考」能对上。
 * 3. 候选要**有文字依据**才算命中：名字整体出现在片段里、片段整体出现在名字里、
 *    或两边有共同的二字片段（「小花音色」与「小花声音」共有「小花」）。
 *    两字以内的短名（「音频」「小花」）放宽到单字重合 —— 否则叫「音频」的节点
 *    永远对不上「小花声音参考」。
 * 4. **类型线索优先**：片段里出现「声音/音色/配音…」时，优先选 AUDIO 素材，
 *    出现「形象/长相/本人…」时优先选 IMAGE 素材。
 *    这样「小花声音参考@」不会被同名的图片节点抢走（cueWords 见下）。
 *    线索**只在有文字依据的候选之间**起优选作用；没有对应类型的候选时，
 *    仍退回文字匹配的结果，不会凭空认领。
 * 5. **一对一**：一个素材最多被认领一次，靠前的 `@` 优先。
 *    同分时按连线顺序取靠前的那个（可预测，不随机）。
 *
 * ## ⚠️ 编号语义不得改动
 * `mentions[i].value` 形如 `{{ref N}}`，N 与 refList 下标严格绑定 —— 下游
 * `applyReferenceTags()`（换成「图片N / 音频N」）与 `startGeneration` 收集素材的顺序都依赖它。
 * 本函数只决定「哪个 @ 用哪个 N」，**绝不重排编号、绝不改写 value**。
 */
export type ReferenceMention = { name: string; value: string; dataType?: string | string[] };

type Candidate = { index: number; name: string; value: string; dataType: string | string[] | undefined };

// 「的/之/地/得」与标点、空白都不参与比较，避免「小花的形象」对不上「小花形象」。
const fillerPattern = /[\s，。、；：,.;:!！?？“”"‘’()（）【】[\]<>《》的之地得]/g;

/**
 * 类型线索词。ACT: 纯启发式词典，只影响「同分数候选之间选谁」，不单独构成命中依据。
 * 想加/改词直接改这里即可；出现了误判说明该词太泛，删掉比加规则便宜。
 */
const cueWords: Record<string, string[]> = {
  AUDIO: ["声音", "音色", "音频", "配音", "语音", "声线", "念白", "旁白", "说话", "歌声", "唱歌", "音乐"],
  IMAGE: ["形象", "外观", "长相", "样子", "模样", "造型", "本人", "服装", "穿着", "表情", "发型", "面孔", "脸"],
  VIDEO: ["视频", "片段", "运镜", "动作", "动效"],
  STRING: ["文本", "文案", "描述", "设定"],
};

export function matchReferenceMentions(text: string, mentions: readonly ReferenceMention[]): { text: string; matched: number; unmatched: string[] } {
  if (!text.includes("@")) return { text, matched: 0, unmatched: [] };
  const candidates: Candidate[] = mentions
    .map((mention, index): Candidate => ({ index, name: normalize(mention.name ?? ""), value: mention.value, dataType: mention.dataType }))
    .filter((candidate) => candidate.name);
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
    const raw = text.slice(segmentStart, cursor);
    const hit = pickCandidate(normalize(raw), candidates, used);
    if (hit) {
      used.add(hit.index);
      result += raw + hit.value;
      matched += 1;
    } else {
      result += text.slice(segmentStart, cursor + 1);
      const description = cleanDescription(raw);
      if (description) unmatched.push(description);
    }
    segmentStart = cursor + 1;
  }
  result += text.slice(segmentStart);
  return { text: matched ? result : text, matched, unmatched };
}

function normalize(text: string) {
  return text.replace(fillerPattern, "").toLowerCase();
}

function pickCandidate(segment: string, candidates: readonly Candidate[], used: ReadonlySet<number>) {
  const qualified = candidates.filter((candidate) => !used.has(candidate.index) && hasTextEvidence(segment, candidate.name));
  if (!qualified.length) return undefined;
  // 线索只在「有文字依据」的候选之间优选；没有对应类型的候选时不强行认领。
  const cued = qualified.filter((candidate) => matchesCue(segment, candidate.dataType));
  const pool = cued.length ? cued : qualified;
  let best = pool[0];
  let bestRank = rank(segment, best);
  for (const candidate of pool) {
    const candidateRank = rank(segment, candidate);
    // 严格大于：同分保留靠前的候选，于是结果只取决于连线顺序，可预测。
    if (compareRank(candidateRank, bestRank) > 0) {
      best = candidate;
      bestRank = candidateRank;
    }
  }
  return best;
}

function hasTextEvidence(segment: string, name: string) {
  if (!segment) return false;
  if (segment.includes(name)) return true;
  if (name.length >= 2 && name.includes(segment)) return true;
  if (sharedBigrams(segment, name) > 0) return true;
  return name.length <= 2 && sharesCharacter(segment, name);
}

/** ACT: 命中优先级 = 名字整体出现 > 共同二字片段多 > 名字更长（更具体）。 */
function rank(segment: string, candidate: Candidate) {
  return [segment.includes(candidate.name) ? 1 : 0, sharedBigrams(segment, candidate.name), candidate.name.length] as const;
}

function compareRank(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < left.length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function sharedBigrams(segment: string, name: string) {
  const target = bigrams(name);
  let count = 0;
  for (const gram of bigrams(segment)) {
    if (target.has(gram)) count += 1;
  }
  return count;
}

function bigrams(text: string) {
  const set = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2));
  return set;
}

function sharesCharacter(segment: string, name: string) {
  for (const char of name) {
    if (segment.includes(char)) return true;
  }
  return false;
}

function matchesCue(segment: string, dataType: string | string[] | undefined) {
  const types = typeof dataType === "string" ? [dataType] : Array.isArray(dataType) ? dataType : [];
  return types.some((type) => (cueWords[type] ?? []).some((word) => segment.includes(word)));
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
