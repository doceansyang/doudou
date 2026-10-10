// 运行：bun packages/nodes/audioNode/scripts/checkAudioClipEditor.ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "@toonflow/file";
import { ref, computed, watch, onBeforeUnmount, useModel, defineComponent, createRenderer, h, nextTick, type Ref } from "vue";
import type { AudioSegment } from "../src/audioProcessing";

type EditState = { groups: AudioSegment[][]; selectedIndex: number; playhead: number };
type Editor = {
  player: Ref<{ currentTime: number; playing: boolean; seekTo(value: number): void; pause(): void }>;
  segments: Ref<AudioSegment[]>;
  groups: Ref<AudioSegment[][]>;
  undoStack: Ref<EditState[]>;
  redoStack: Ref<EditState[]>;
  selectedIndex: Ref<number>;
  playhead: Ref<number>;
  totalDuration: Ref<number>;
  valid: Ref<boolean>;
  canSplit: Ref<boolean>;
  readDuration(event: Event): void;
  selectSegment(index: number, event?: MouseEvent): void;
  splitSegment(): void;
  mergeSegment(): void;
  removeSegment(): void;
  undo(): void;
  redo(): void;
  seekAt(time: number): void;
  seekCursor(event: Event): void;
  startPlayback(): void;
  pause(): void;
};

const source = await readFile(join(import.meta.dir, "../src/components/audioClipEditor.vue"), "utf8");
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "必须读取实际组件脚本");
// ACT: 检查单轨分组与真实受控 model；音频由最小替身驱动，DOM 命中与实际播放需浏览器验证。
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(script.replace(/^import .*;\r?$/gm, "")
  + "\nreturn { player, segments, groups, undoStack, redoStack, selectedIndex, playhead, totalDuration, valid, canSplit, readDuration, selectSegment, splitSegment, mergeSegment, removeSegment, undo, redo, seekAt, seekCursor, startPlayback, pause };");
const setup = new Function("ref", "computed", "watch", "onBeforeUnmount", "defineProps", "defineModel", "defineExpose", code);
let editor: Editor;
const seeks: number[] = [];
const model = ref<AudioSegment[]>([]);
const disabled = ref(false);
const audioSource = ref("audio.mp3");
const child = defineComponent({
  props: ["src", "disabled", "modelValue"],
  emits: ["update:modelValue"],
  setup(props) {
    editor = setup(ref, computed, watch, onBeforeUnmount, () => props, () => useModel(props, "modelValue"), () => {});
    editor.player.value = {
      currentTime: 0, playing: false,
      seekTo(value) { seeks.push(value); editor.player.value.currentTime = value; },
      pause() { editor.player.value.playing = false; },
    };
    return () => null;
  },
});
type HostNode = { parent?: HostNode };
const renderer = createRenderer<HostNode, HostNode>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert: (node, parent) => { node.parent = parent; },
  remove: () => {}, setText: () => {}, setElementText: () => {}, patchProp: () => {},
  parentNode: node => node.parent ?? null, nextSibling: () => null,
});
const app = renderer.createApp({
  render: () => h(child, {
    src: audioSource.value, disabled: disabled.value, modelValue: model.value,
    "onUpdate:modelValue": (value: AudioSegment[]) => { model.value = value; },
  }),
});
app.mount({});

function state(): EditState {
  return {
    groups: Array.from(editor!.groups.value, group => Array.from(group, range => ({ start: range.start, end: range.end }))),
    selectedIndex: editor!.selectedIndex.value,
    playhead: editor!.playhead.value,
  };
}

function output() {
  return Array.from(model.value, range => ({ start: range.start, end: range.end }));
}

function cursor(value: number) {
  editor!.seekCursor({ target: { valueAsNumber: value } } as unknown as Event);
}

try {
  editor!.readDuration({ currentTarget: { duration: 10 } } as unknown as Event);
  assert.equal(editor!.segments.value.length, 0, "输出 model 初始化须等待父组件回传");
  assert.equal(editor!.groups.value.length, 1, "本地分组立即可用");
  await nextTick();
  assert.equal(editor!.undoStack.value.length, 0, "元数据初始化不成为可撤销编辑");
  const beforeActions: EditState[] = [];
  editor!.seekAt(2);
  beforeActions.push(state());
  editor!.splitSegment();
  assert.equal(model.value.length, 2);
  assert.equal(editor!.segments.value.length, 1, "分割本轮仍读取旧 prop");
  assert.equal(editor!.groups.value.length, 2);
  await nextTick();
  editor!.seekAt(6);
  beforeActions.push(state());
  editor!.splitSegment();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 0, end: 2 }], [{ start: 2, end: 6 }], [{ start: 6, end: 10 }]]);
  editor!.selectSegment(1);
  beforeActions.push(state());
  editor!.removeSegment();
  assert.equal(seeks.at(-1), 6, "删中段后立即定位下一源区间");
  await nextTick();
  assert.equal(editor!.playhead.value, 2);
  assert.equal(editor!.totalDuration.value, 6);
  beforeActions.push(state());
  editor!.mergeSegment();
  const merged = state();
  assert.deepEqual(merged.groups, [[{ start: 0, end: 2 }, { start: 6, end: 10 }]]);
  await nextTick();
  assert.deepEqual(state(), merged, "父输出 model 回传不能把已粘合分组打散");
  assert.deepEqual(output(), [{ start: 0, end: 2 }, { start: 6, end: 10 }], "粘合导出仍保留删除的 2 至 6 秒缺口");
  for (let index = beforeActions.length - 1; index >= 0; index--) {
    editor!.undo();
    await nextTick();
    assert.deepEqual(state(), beforeActions[index], "多步撤销完整恢复分组、选中和游标");
    assert.deepEqual(output(), beforeActions[index]!.groups.flat());
  }
  const afterActions = [...beforeActions.slice(1), merged];
  for (const expected of afterActions) {
    editor!.redo();
    await nextTick();
    assert.deepEqual(state(), expected, "多步恢复完整重放分组、选中和游标");
    assert.deepEqual(output(), expected.groups.flat());
  }

  cursor(3);
  await nextTick();
  assert.equal(seeks.at(-1), 7, "粘合组输出 3 秒映射到源 7 秒");
  assert.equal(editor!.undoStack.value.length, 4, "拖动游标不记录编辑历史");
  const beforeSplit = state();
  editor!.splitSegment();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 0, end: 2 }, { start: 6, end: 7 }], [{ start: 7, end: 10 }]], "粘合片段可在内部源区间再次分割");
  assert.equal(editor!.totalDuration.value, 6);
  editor!.undo();
  await nextTick();
  assert.deepEqual(state(), beforeSplit);
  cursor(2);
  await nextTick();
  assert.equal(seeks.at(-1), 6, "源区间内部边界定位到后一保留区间");
  editor!.splitSegment();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 0, end: 2 }], [{ start: 6, end: 10 }]], "内部区间边界分割不能生成零长度区间");
  assert.equal(editor!.redoStack.value.length, 0, "撤销后新编辑清空恢复分支");
  editor!.undo();
  await nextTick();
  editor!.selectSegment(0, { detail: 1, clientX: 200, currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 200 }) } } as unknown as MouseEvent);
  await nextTick();
  assert.equal(editor!.playhead.value, 3, "点击粘合块中点按保留时长定位");
  assert.equal(seeks.at(-1), 7);
  cursor(99);
  assert.equal(editor!.playhead.value, 6);
  assert.equal(seeks.at(-1), 10, "游标不能超出保留音频末端");

  cursor(0.5);
  editor!.player.value.playing = true;
  editor!.startPlayback();
  editor!.player.value.currentTime = 2.1;
  await nextTick();
  assert.equal(seeks.at(-1), 6, "同一粘合组内播放仍跳过删除的源区间");
  assert.equal(editor!.selectedIndex.value, 0);
  assert.equal(editor!.playhead.value, 2);
  editor!.player.value.currentTime = 10;
  await nextTick();
  assert.equal(editor!.playhead.value, 6);
  assert.equal(editor!.player.value.playing, false);
  editor!.player.value.playing = true;
  editor!.startPlayback();
  await nextTick();
  assert.equal(seeks.at(-1), 0, "播放结束后再次从头开始");

  cursor(1);
  editor!.splitSegment();
  await nextTick();
  const beforeFirstDelete = state();
  editor!.selectSegment(0);
  editor!.removeSegment();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 1, end: 2 }, { start: 6, end: 10 }]], "可删除首组");
  assert.equal(seeks.at(-1), 1);
  editor!.undo();
  await nextTick();
  assert.deepEqual(state().groups, beforeFirstDelete.groups);
  editor!.selectSegment(1);
  editor!.removeSegment();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 0, end: 1 }]], "可删除末组");
  editor!.removeSegment();
  await nextTick();
  assert.deepEqual(state().groups, []);
  assert.equal(editor!.valid.value, false);
  editor!.undo();
  await nextTick();
  assert.deepEqual(state().groups, [[{ start: 0, end: 1 }]], "全部删空后仍可撤销恢复");
  assert.equal(editor!.valid.value, true);

  editor!.player.value.playing = true;
  disabled.value = true;
  await nextTick();
  assert.equal(editor!.player.value.playing, false, "处理禁用时暂停音频");
  const beforeDisabled = state();
  const historyLengths = [editor!.undoStack.value.length, editor!.redoStack.value.length];
  cursor(0.5);
  editor!.selectSegment(0);
  editor!.splitSegment();
  editor!.mergeSegment();
  editor!.removeSegment();
  editor!.undo();
  editor!.redo();
  editor!.startPlayback();
  assert.deepEqual(state(), beforeDisabled, "禁用时不能定位、编辑或恢复历史");
  assert.deepEqual([editor!.undoStack.value.length, editor!.redoStack.value.length], historyLengths);
  disabled.value = false;
  await nextTick();
  cursor(Number.NaN);
  assert.deepEqual(state(), beforeDisabled, "非法游标值不能污染状态");
  audioSource.value = "replacement.mp3";
  await nextTick();
  assert.deepEqual(state(), { groups: [], selectedIndex: 0, playhead: 0 });
  assert.deepEqual(output(), []);
  assert.equal(editor!.undoStack.value.length, 0, "换源清空撤销历史");
  assert.equal(editor!.redoStack.value.length, 0, "换源清空恢复历史");
  assert.equal(editor!.valid.value, false);
  console.log("audioClipEditor OK: 分组粘合保留源缺口、再次分割、滑动定位、播放跳段、多步撤销恢复及禁用换源");
} finally {
  app.unmount();
  assert.equal(editor!.player.value.playing, false, "卸载时停止播放");
}
