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
 * 2. 归一化后比较：去掉文件扩展名（`.mp3`/`.png`…）、空白、标点与「的/之/地/得」这类连接字，
 *    于是「小花的形象」「大军音色.mp3」和「小花形象参考」「大军音色参考」都能对上。
 * 3. 候选要**有文字依据**才算命中：名字整体出现在片段里、片段整体出现在名字里、
 *    或两边有共同的二字片段（「小花音色」与「小花声音」共有「小花」）。
 *    两字以内的短名（「音频」「小花」）放宽到单字重合 —— 否则叫「音频」的节点
 *    永远对不上「小花声音参考」。
 * 4. **先是类型线索、再是文字**：
 *    - `声音/音色/配音…` 这类线索**只认 AUDIO 素材**，对不上宁可留空（如实回报），
 *      绝不用图片顶替 —— 音频的名字描述的是声音本身，图片/视频的名字描述的是画面，
 *      两者本就不该互相顶替。
 *    - `形象/本人/图片…`、`视频/片段…` 这类线索只在**同类之间优选**，没有对应类型的素材时
 *      仍退回文字匹配，避免把画面素材误伤成「对不上」。
 *    - 片段里**只有类型词**（「视频参考@」「音频参考@」）时，直接按类型认领对应素材，
 *      不再要求名字里有同样的字 —— 上游视频节点叫「走路」也拉得到（每条素材仍只认领一次）。
 * 5. **先分配点明类型的那几个 `@`**：否则「大军及衣服鸭子图案参考@」这种没写类型词的片段
 *    会先把音频抢走，轮到「大军音色参考@」就只剩图片了（实测踩过）。
 * 6. **一对一**：一个素材最多被认领一次；同分时按连线顺序取靠前的（可预测，不随机）。
 *
 * ## ⚠️ 编号语义不得改动
 * `mentions[i].value` 形如 `{{ref N}}`，N 与 refList 下标严格绑定 —— 下游
 * `applyReferenceTags()`（换成「图片N / 音频N」）与 `startGeneration` 收集素材的顺序都依赖它。
 * 本函数只决定「哪个 @ 用哪个 N」，**绝不重排编号、绝不改写 value**。
 */
export type ReferenceMention = { name: string; value: string; dataType?: string | string[] };

type Candidate = { index: number; name: string; value: string; dataType: string | string[] | undefined };
type Mark = { at: number; raw: string; segment: string };

// 文件扩展名先去掉：上游音频节点常被命名成「大军音色.mp3」，带着它会让名字整体对不上。
const extensionPattern = /\.[a-z0-9]{1,5}$/i;
// 「的/之/地/得」与标点、空白都不参与比较，避免「小花的形象」对不上「小花形象」。
const fillerPattern = /[\s，。、；：,.;:!！?？“”"‘’()（）【】[\]<>《》的之地得]/g;

/**
 * 类型线索词。ACT: 纯启发式词典。想加/改词直接改这里即可；
 * 出现误判说明该词太泛，删掉比再加一层规则便宜。
 */
const cueWords: Record<string, string[]> = {
  AUDIO: ["声音", "音色", "音频", "配音", "语音", "声线", "念白", "旁白", "说话", "歌声", "唱歌", "音乐"],
  IMAGE: ["图片", "形象", "外观", "长相", "样子", "模样", "造型", "本人", "服装", "衣服", "穿着", "表情", "发型", "面孔", "脸"],
  VIDEO: ["视频", "片段", "运镜", "动作", "动效"],
  STRING: ["文本", "文案", "描述", "设定"],
};

/** 出现即「只认这一类」的线索：音频。其余线索只做同类优选，见文件头说明。 */
const strictCueTypes = ["AUDIO"];

export function matchReferenceMentions(text: string, mentions: readonly ReferenceMention[]): { text: string; matched: number; unmatched: string[] } {
  if (!text.includes("@")) return { text, matched: 0, unmatched: [] };
  const candidates: Candidate[] = mentions
    .map((mention, index): Candidate => ({ index, name: normalize(mention.name ?? ""), value: mention.value, dataType: mention.dataType }))
    .filter((candidate) => candidate.name);
  if (!candidates.length) return { text, matched: 0, unmatched: [] };

  // 先切出每个 @ 的描述片段（到上一个 @、换行或开头为止），再分两遍分配。
  const marks: Mark[] = [];
  let segmentStart = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\n") {
      segmentStart = cursor + 1;
      continue;
    }
    if (char !== "@") continue;
    const raw = text.slice(segmentStart, cursor);
    marks.push({ at: cursor, raw, segment: normalize(raw) });
    segmentStart = cursor + 1;
  }
  if (!marks.length) return { text, matched: 0, unmatched: [] };

  const used = new Set<number>();
  const assigned = new Map<number, string>();
  // 先点明类型的，再没点类型的：否则「大军及衣服鸭子图案参考@」会先把音频抢走。
  const ordered = [...marks.filter((mark) => cueTypes(mark.segment).length), ...marks.filter((mark) => !cueTypes(mark.segment).length)];
  for (const mark of ordered) {
    const hit = pickCandidate(mark.segment, candidates, used);
    if (!hit) continue;
    used.add(hit.index);
    assigned.set(mark.at, hit.value);
  }

  const unmatched: string[] = [];
  let result = "";
  let cursor = 0;
  let matched = 0;
  for (const mark of marks) {
    result += text.slice(cursor, mark.at);
    const value = assigned.get(mark.at);
    if (value === undefined) {
      result += "@";
      const description = cleanDescription(mark.raw);
      if (description) unmatched.push(description);
    } else {
      result += value;
      matched += 1;
    }
    cursor = mark.at + 1;
  }
  result += text.slice(cursor);
  return { text: matched ? result : text, matched, unmatched };
}

function normalize(text: string) {
  return text.replace(extensionPattern, "").replace(fillerPattern, "").toLowerCase();
}

function pickCandidate(segment: string, candidates: readonly Candidate[], used: ReadonlySet<number>) {
  const available = candidates.filter((candidate) => !used.has(candidate.index));
  const types = cueTypes(segment);
  const ofType = available.filter((candidate) => dataTypes(candidate.dataType).some((type) => types.includes(type)));
  // 片段里只有类型词（「视频参考@」「音频参考@」）⇒ 按类型直接认领，不看名字：
  // 上游视频节点无论叫什么（哪怕是「走路」）都拉得到。
  if (isTypeOnly(segment, types) && ofType.length) return best(segment, ofType);
  const qualified = available.filter((candidate) => hasTextEvidence(segment, candidate.name));
  const strict = types.filter((type) => strictCueTypes.includes(type));
  if (strict.length) {
    // 说了「音色/声音」就只认音频；对不上留空，让用户看到没匹配上，而不是拿图片顶替。
    return best(segment, qualified.filter((candidate) => dataTypes(candidate.dataType).some((type) => strict.includes(type))));
  }
  const preferred = qualified.filter((candidate) => dataTypes(candidate.dataType).some((type) => types.includes(type)));
  return best(segment, preferred.length ? preferred : qualified);
}

function best(segment: string, pool: readonly Candidate[]) {
  let picked = pool[0];
  if (!picked) return undefined;
  let pickedRank = rank(segment, picked);
  for (const candidate of pool) {
    const candidateRank = rank(segment, candidate);
    // 严格大于：同分保留靠前的候选，于是结果只取决于连线顺序，可预测。
    if (compareRank(candidateRank, pickedRank) > 0) {
      picked = candidate;
      pickedRank = candidateRank;
    }
  }
  return picked;
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

function dataTypes(dataType: string | string[] | undefined) {
  return typeof dataType === "string" ? [dataType] : Array.isArray(dataType) ? dataType : [];
}

function cueTypes(segment: string) {
  return Object.keys(cueWords).filter((type) => (cueWords[type] ?? []).some((word) => segment.includes(word)));
}

/** 类型词之外的虚词，出现与否不影响「这段只写了类型」的判断。 */
const typeOnlyFillers = ["参考", "素材", "一张", "一个", "这段", "那个"];

/** 片段里除了类型词与上面的虚词没有别的内容，例如「视频参考」「一张音频参考」。 */
function isTypeOnly(segment: string, types: string[]) {
  if (!types.length) return false;
  let rest = segment;
  for (const type of types) {
    for (const word of cueWords[type] ?? []) rest = rest.split(word).join("");
  }
  for (const word of typeOnlyFillers) rest = rest.split(word).join("");
  return rest.length === 0;
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
