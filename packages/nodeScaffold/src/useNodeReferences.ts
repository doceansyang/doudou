import { computed, ref } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeData } from "./connection";
import { useNodeEvent } from "./nodeEvent";
import type { NodeInputValue } from "./values";

/**
 * 音频参考的占位缩略图（内联 SVG data-URI，不依赖网络）。
 *
 * 为什么要它：节点里打 `@` 弹出的「选择参考」菜单**只认 `avatar`** 一个字段
 * （x-sender 的 `MentionItem = { id, name, avatar?, pinyin? }`，没有任何类型字段），
 * 而我们的缩略图只对图片/视频回填（见下面 previews 的维护逻辑）⇒ 音频那几行
 * 渲染成一块近乎全黑的方块（实测像素 rgb(23,23,23)，菜单底 rgb(29,30,31)，等于看不见），
 * 用户原话「显示不正常」。这里给音频一个中性底 + 音符的图标，深浅色下都看得清。
 *
 * ⚠️ 它只是"图标"，不是真实预览 —— 所以 promptInput 里点标签弹大图那条路要跳过音频
 * （否则会拿这个图标去开图片查看器）。
 */
const AUDIO_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
      '<rect width="40" height="40" rx="8" fill="#3a3d42"/>' +
      '<circle cx="15" cy="27" r="4.5" fill="#e8eaed"/>' +
      '<circle cx="28.5" cy="24" r="4.5" fill="#e8eaed"/>' +
      '<rect x="18" y="11" width="2.6" height="16" fill="#e8eaed"/>' +
      '<rect x="31.5" y="8" width="2.6" height="16" fill="#e8eaed"/>' +
      '<rect x="18" y="11" width="16.1" height="2.6" fill="#e8eaed"/>' +
    "</svg>"
  );

export function useNodeReferences(handleId = "in") {
  const { id, node } = useNode<NodeData & { referenceOrder?: Record<string, string[]> }>();
  const { nodeLookup, removeEdges } = useVueFlow();
  const inputValues = ref<NodeInputValue[]>([]);
  const previews = ref(new Map<string, string>());
  const refList = computed({
    get() {
      const order = new Map(node.data.referenceOrder?.[handleId]?.map((key, index) => [key, index]));
      return [...inputValues.value].sort((a, b) => (order.get(referenceKey(a)) ?? order.size) - (order.get(referenceKey(b)) ?? order.size));
    },
    set(values: NodeInputValue[]) {
      node.data.referenceOrder = { ...node.data.referenceOrder, [handleId]: values.map(referenceKey) };
    },
  });
  const referenceMentions = computed(() => refList.value.flatMap((item, index) =>
    typeof item.dataType === "string" && ["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(item.dataType)
      ? [{
        id: referenceKey(item),
        // 名字取上游节点标题（用户会把图片/音频节点改名成「小花形象」这类素材名），
        // 没改名时回退「参考 N」；`value` 的编号必须与 refList 下标一致，不能动。
        name: sourceLabel(nodeLookup.value.get(item.source)) ?? `参考 ${index + 1}`,
        value: `{{ref ${index + 1}}}`,
        // 类型供「匹配元素」按线索优选（如「小花声音参考@」优先选音频素材）。
        dataType: item.dataType,
        // 图片/视频用真实缩略图；音频没有缩略图概念，给个音符图标兜底
        // （不给的话「选择参考」菜单里会渲染成一块黑，见 AUDIO_ICON 的注释）。
        avatar: previews.value.get(referenceKey(item)) || (item.dataType === "AUDIO" ? AUDIO_ICON : undefined),
      }]
      : []
  ));

  useNodeEvent().on(`input:${handleId}`, (values) => {
    inputValues.value = values;
    const ids = new Set(values.filter(item => item.dataType === "IMAGE" || item.dataType === "VIDEO").map(referenceKey));
    for (const key of previews.value.keys()) {
      if (!ids.has(key)) previews.value.delete(key);
    }
  });

  function setReferencePreview(item: NodeInputValue, url: string) {
    previews.value.set(referenceKey(item), url);
  }

  function removeReference(item: NodeInputValue) {
    removeEdges(edges => edges.filter(edge =>
      edge.target === id && edge.targetHandle === handleId && edge.source === item.source && edge.sourceHandle === item.sourceHandle
    ));
  }

  return { refList, referenceMentions, setReferencePreview, removeReference };
}

function referenceKey(item: NodeInputValue) {
  return encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
}

function sourceLabel(source: { data?: { label?: unknown }; label?: unknown } | undefined) {
  const label = source?.data?.label ?? source?.label;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}
