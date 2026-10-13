<template>
  <selectionHandle
    v-if="!singleGroupSelected"
    ref="selectionHandleRef"
    @start="startSelectionConnection"
    @release="(event, nodes) => openMenu(event, true, [], undefined, nodes)" />
  <selectionHandle
    v-for="group in groups"
    :key="group.id"
    ref="groupHandleRefs"
    :nodes="[group]"
    @start="startSelectionConnection"
    @release="(event, nodes) => openMenu(event, true, [], undefined, nodes)" />
  <el-dropdown
    ref="menu"
    trigger="contextmenu"
    virtualTriggering
    :virtualRef="menuAnchor"
    placement="bottom-start"
    :showArrow="false"
    :showTimeout="0"
    :hideTimeout="0"
    :hideOnClick="false"
    @command="handleCommand"
    @visibleChange="(visible: boolean) => !visible && clearConnection()">
    <template #dropdown>
      <el-dropdown-menu
        ref="menuList"
        class="nodeMenu"
        :aria-label="menuLevel === 'selection' ? '选区操作' : menuLevel === 'arrange' ? '整理选中节点' : menuLevel === 'actions' ? '操作菜单' : '添加节点'">
        <template v-if="menuLevel === 'selection'">
          <el-dropdown-item command="duplicateSelection" :icon="IconCopyPlus" :disabled="selectionBusy || deleting || !selectedNodes.length">
            创建副本
          </el-dropdown-item>
          <el-dropdown-item command="arrange" :icon="IconLayoutGrid" :disabled="!canArrangeSelection">
            <span>整理选中节点</span>
            <icon-chevron-right class="nextIcon" :size="14" />
          </el-dropdown-item>
          <el-dropdown-item
            command="deleteSelection"
            :icon="IconTrash"
            :disabled="selectionBusy || deleting || !selectedNodes.some((node) => node.deletable !== false)">
            {{ deleting ? "删除中…" : `删除选中节点（${selectedNodes.length}）` }}
          </el-dropdown-item>
        </template>
        <template v-else-if="menuLevel === 'arrange'">
          <el-dropdown-item command="selection" :icon="IconChevronLeft">返回选区操作</el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="horizontal" :icon="IconLayoutColumns" :disabled="!canArrangeSelection">水平排列</el-dropdown-item>
          <el-dropdown-item command="vertical" :icon="IconLayoutRows" :disabled="!canArrangeSelection">垂直排列</el-dropdown-item>
          <el-dropdown-item command="grid" :icon="IconLayoutGrid" :disabled="!canArrangeSelection">宫格排列</el-dropdown-item>
        </template>
        <template v-else-if="menuLevel === 'actions'">
          <el-dropdown-item command="upload" :icon="IconUpload" :disabled="!uploadFiles">上传</el-dropdown-item>
          <el-dropdown-item command="nodes" :icon="IconPlus">
            <span>添加节点</span>
            <icon-chevron-right class="nextIcon" :size="14" />
          </el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="undo" :icon="IconArrowBackUp" :disabled="!canUndo">撤销</el-dropdown-item>
          <el-dropdown-item command="redo" :icon="IconArrowForwardUp" :disabled="!canRedo">重做</el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="paste" :icon="IconClipboard" :disabled="!pasteNode || pasting">
            {{ pasting ? "粘贴中…" : "从剪贴板粘贴" }}
          </el-dropdown-item>
        </template>
        <template v-else>
          <el-dropdown-item v-if="!directNodes" command="actions" :icon="IconChevronLeft">返回操作菜单</el-dropdown-item>
          <el-dropdown-item v-else disabled>添加节点</el-dropdown-item>
          <el-dropdown-item v-for="node in filteredNodes" :key="node.type" :command="node.type" :icon="node.icon">
            {{ node.label }}
          </el-dropdown-item>
          <el-dropdown-item v-if="(pendingHandle || pendingGroup.length) && !filteredNodes.length" disabled>没有可连接的节点</el-dropdown-item>
        </template>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, type Component } from "vue";
import { useVueFlow, type ConnectingHandle, type GraphNode, type HandleType } from "@vue-flow/core";
import { isTypeCompatible, useNodeEvent, validateConnection, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { ElMessage } from "element-plus";
import type { DropdownInstance } from "element-plus";
import selectionHandle from "./selectionHandle.vue";
import { getSelectionConnections } from "../selectionConnections";
import { getSelectionRoots, getSelectionTree } from "../selectionNodes";
import { arrangeSelection } from "../arrangeSelection";
import {
  IconClipboard,
  IconCopyPlus,
  IconTrash,
  IconBox,
  IconUpload,
  IconPlus,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutColumns,
  IconLayoutRows,
  IconLayoutGrid,
} from "@tabler/icons-vue";

const { remoteNodes = [], pasteNode, uploadFiles, canUndo = false, canRedo = false, selectionBusy = false, batchHistory } = defineProps<{
  remoteNodes?: { type: string; label: string }[];
  pasteNode?: (position: { x: number; y: number }) => Promise<boolean>;
  uploadFiles?: (position: { x: number; y: number }) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  selectionBusy?: boolean;
  batchHistory?: (action: () => Promise<void>) => Promise<void>;
}>();
const emit = defineEmits<{ history: []; undo: []; redo: []; duplicateSelection: [] }>();
const menu = ref<DropdownInstance>();
const menuList = ref<{ $el: HTMLElement }>();
const menuLevel = ref<"actions" | "nodes" | "selection" | "arrange">("actions");
const selectedNodes = shallowRef<GraphNode[]>([]);
const deleting = ref(false);
const pasting = ref(false);
const directNodes = ref(false);
const menuAnchor = shallowRef({ getBoundingClientRect: () => new DOMRect() });
const flow = useVueFlow();
const { addNodes, screenToFlowCoordinate, onPaneContextMenu, onSelectionContextMenu, onPaneClick, onMoveStart } = flow;
let nodePosition = { x: 0, y: 0 };
type DraggedHandle = { node: GraphNode; id: string; type: HandleType; start: ConnectingHandle };
const pendingHandle = shallowRef<DraggedHandle>();
const pendingGroup = shallowRef<GraphNode[]>([]);
const selectionHandleRef = ref<InstanceType<typeof selectionHandle>>();
const groupHandleRefs = ref<InstanceType<typeof selectionHandle>[]>([]);
const groups = computed(() => flow.getNodes.value.filter(node => node.type === "canvasGroup" && !node.hidden));
const singleGroupSelected = computed(() => flow.getSelectedNodes.value.length === 1 && flow.getSelectedNodes.value[0]?.type === "canvasGroup");
const canArrangeSelection = computed(() => {
  const nodes = getSelectionRoots(selectedNodes.value, flow.getNodes.value);
  return !selectionBusy && !deleting.value && nodes.length > 1
    && nodes.every(node => flow.findNode(node.id) === node && node.draggable !== false
      && Number.isFinite(node.dimensions.width) && node.dimensions.width > 0
      && Number.isFinite(node.dimensions.height) && node.dimensions.height > 0);
});
const nodeOrder: Record<string, number> = { "remote-textNode": 0, "remote-imageNode": 1, "remote-videoNode": 2, "remote-audioNode": 3 };
const filteredNodes = computed(() => {
  const nodes = remoteNodes.map(node => ({
    ...node,
    icon: (flow.nodeTypes?.value?.[node.type] as { icon?: Component } | undefined)?.icon ?? IconBox,
  })).sort((left, right) => (nodeOrder[left.type] ?? 4) - (nodeOrder[right.type] ?? 4));
  if (pendingGroup.value.length) {
    if (!flow.nodesConnectable.value || pendingGroup.value.some(node => flow.findNode(node.id) !== node || node.connectable === false)) return [];
    return nodes.filter(node => {
      const targets = (flow.nodeTypes?.value?.[node.type] as { handles?: NodeHandle[] } | undefined)?.handles?.filter(handle => handle.type === "target") ?? [];
      return pendingGroup.value.every(source => (source.data.handles as NodeHandle[] | undefined)?.some(output =>
        output.type === "source" && targets.some(input => isTypeCompatible(output.dataType, input.dataType))));
    });
  }
  const handle = pendingHandle.value;
  if (!handle) return nodes;
  if (flow.findNode(handle.node.id) !== handle.node || !flow.nodesConnectable.value || handle.node.connectable === false) return [];
  const port = (handle.node.data.handles as NodeHandle[] | undefined)?.find((item) => item.id === handle.id && item.type === handle.type);
  if (!port) return [];
  return nodes.filter((node) => {
    const handles = (flow.nodeTypes?.value?.[node.type] as { handles?: NodeHandle[] } | undefined)?.handles;
    return handles?.some((item) => item.type !== port.type && isTypeCompatible(port.dataType, item.dataType));
  });
});

function clearSelectionHandles() {
  selectionHandleRef.value?.clear();
  groupHandleRefs.value.forEach(handle => handle.clear());
}

function clearConnection() {
  if (pendingHandle.value) {
    pendingHandle.value = undefined;
    flow.endConnection();
  }
  if (pendingGroup.value.length) {
    pendingGroup.value = [];
    clearSelectionHandles();
  }
}

function startSelectionConnection() {
  clearConnection();
  clearSelectionHandles();
  menu.value?.handleClose();
}

/**
 * 把正在拖的连线**吸附**到落点所在的那个节点上 —— 用户不必精确命中端口那个小圆点。
 *
 * 为什么需要补这一手：Vue Flow 判定落点，只认 `document.elementFromPoint()` 命中的元素
 * **本身**是不是 `.vue-flow__handle`；拖到节点身上（哪怕就压在端口旁边几像素）它都会认为
 * "没连上"，然后把这条线丢掉。这里在松手时补一次"按节点吸附"，手感才符合直觉。
 *
 * 端口挑选：**同类型兼容的端口优先**，再退到"任意能通过校验"的端口（例如两个都是宽松端口）。
 * 校验复用画布工具那一套 `validateConnection`，所以方向、数据类型、去重规则与菜单建边完全一致。
 */
function snapConnectionToNode(free: GraphNode, handle: ConnectingHandle): boolean {
  const fixed = flow.findNode(handle.nodeId);
  if (!fixed || handle.id == null || fixed.id === free.id) return false;
  if (!flow.nodesConnectable.value || fixed.connectable === false || free.connectable === false) return false;
  const wantType: HandleType = handle.type === "source" ? "target" : "source";
  const freeHandles = ((free.data.handles as NodeHandle[] | undefined) ?? []).filter(item => item.type === wantType);
  if (!freeHandles.length) return false;
  const fixedHandle = ((fixed.data.handles as NodeHandle[] | undefined) ?? []).find(item => item.id === handle.id);
  const fromSource = handle.type === "source";
  // ACT: 接线方向可能正反两种（从输出端拖到节点，或从输入端拖到节点），这里统一成 Connection。
  const connectionOf = (freeHandle: NodeHandle) => ({
    source: fromSource ? fixed.id : free.id,
    sourceHandle: fromSource ? handle.id! : freeHandle.id,
    target: fromSource ? free.id : fixed.id,
    targetHandle: fromSource ? freeHandle.id : handle.id!,
  });
  const compatible = (freeHandle: NodeHandle) => !fixedHandle
    || (fromSource
      ? isTypeCompatible(fixedHandle.dataType, freeHandle.dataType)
      : isTypeCompatible(freeHandle.dataType, fixedHandle.dataType));
  const ordered = [...freeHandles.filter(compatible), ...freeHandles.filter(item => !compatible(item))];
  const sourceNode = fromSource ? fixed : free;
  const targetNode = fromSource ? free : fixed;
  for (const freeHandle of ordered) {
    const connection = connectionOf(freeHandle);
    const edges = flow.getEdges.value;
    // 已经有同样的连线就直接收工，别叠一条重复的。
    if (edges.some(edge => edge.source === connection.source && edge.target === connection.target
      && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle)) return false;
    if (!validateConnection(connection, { sourceNode, targetNode, nodes: flow.getNodes.value, edges })) continue;
    flow.addEdges([{ id: crypto.randomUUID(), ...connection }]);
    return true;
  }
  return false;
}

onBeforeUnmount(clearConnection);
flow.onConnectStart(() => {
  pendingHandle.value = undefined;
  clearConnection();
  menu.value?.handleClose();
});

flow.onConnectEnd((event) => {
  const handle = flow.connectionStartHandle.value;
  if (!handle || flow.connectionStatus.value === "valid" || !event || event.type === "touchcancel") return;
  const node = flow.findNode(handle.nodeId);
  if (!node || handle.id == null) return;
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point) return;
  const target = document.elementFromPoint(point.clientX, point.clientY);
  if (!target || !flow.vueFlowRef.value?.contains(target)) return;
  // ★ 落在**节点身上**（不必精确命中端口）→ 直接吸附到该节点最合适的端口。
  const droppedOn = target.closest(".vue-flow__node") as HTMLElement | null;
  if (droppedOn) {
    const free = flow.findNode(droppedOn.getAttribute("data-id") ?? "");
    if (free && free.id !== node.id && free.connectable !== false && flow.nodesConnectable.value) {
      if (!snapConnectionToNode(free, handle)) ElMessage.warning("该节点没有兼容的端口可连接");
    }
    // 落在自己身上、或节点不可连接：静默收工（不要弹菜单，免得打断）
    return;
  }
  if (!target.classList.contains("vue-flow__pane")) return;
  void openMenu(event, true, [], { node, id: handle.id, type: handle.type, start: { ...handle } });
});

async function openMenu(event: MouseEvent | TouchEvent, nodesOnly = false, selection: GraphNode[] = [], handle?: DraggedHandle, group: GraphNode[] = []) {
  event.preventDefault();
  event.stopPropagation();
  emit("history");
  menu.value?.handleClose();
  clearConnection();
  await nextTick();
  if (!menu.value || (handle && flow.findNode(handle.node.id) !== handle.node)) return;
  pendingHandle.value = handle;
  pendingGroup.value = group;
  directNodes.value = nodesOnly;
  selectedNodes.value = [...selection];
  menuLevel.value = selection.length ? "selection" : nodesOnly ? "nodes" : "actions";
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point) return;
  const { clientX, clientY } = point;
  nodePosition = screenToFlowCoordinate({ x: clientX, y: clientY });
  menuAnchor.value = { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) };
  if (handle) {
    const bounds = flow.vueFlowRef.value!.getBoundingClientRect();
    // ACT: VueFlow 在释放后清空拖线；菜单期间复用其预览，避免创建临时节点或边。
    flow.startConnection(handle.start, { x: clientX - bounds.left, y: clientY - bounds.top });
  }
  await nextTick();
  menu.value?.handleOpen();
}

onPaneContextMenu(openMenu);
onSelectionContextMenu(({ event, nodes }) => openMenu(event, false, nodes));
onPaneClick(() => menu.value?.handleClose());
onMoveStart(() => menu.value?.handleClose());
flow.onNodeContextMenu(() => {
  clearConnection();
  menu.value?.handleClose();
});
defineExpose({ openMenu, deleteSelection });

async function handleCommand(command: unknown) {
  if (command === "nodes" || command === "actions" || command === "selection" || command === "arrange") {
    if (command === "arrange" && !canArrangeSelection.value) return;
    menuLevel.value = command;
    await nextTick();
    menuList.value?.$el.focus();
    return;
  }
  if (command === "duplicateSelection") {
    if (selectionBusy || deleting.value || !selectedNodes.value.length) return;
    menu.value?.handleClose();
    emit("duplicateSelection");
    return;
  }
  if (command === "upload") {
    menu.value?.handleClose();
    uploadFiles?.({ ...nodePosition });
    return;
  }
  if (command === "undo" || command === "redo") {
    if (command === "undo" ? !canUndo : !canRedo) return;
    menu.value?.handleClose();
    if (command === "undo") emit("undo");
    else emit("redo");
    return;
  }
  if (batchHistory) {
    try {
      await batchHistory(() => runCommand(command));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "画布操作失败");
    }
    return;
  }
  await runCommand(command);
}

async function runCommand(command: unknown) {
  if (command === "horizontal" || command === "vertical" || command === "grid") {
    if (!canArrangeSelection.value) return;
    arrangeSelection(flow, selectedNodes.value, command);
    menu.value?.handleClose();
    return;
  }
  if (command === "paste") {
    if (!pasteNode || pasting.value) return;
    pasting.value = true;
    try {
      if (await pasteNode({ ...nodePosition })) menu.value?.handleClose();
    } finally {
      pasting.value = false;
    }
    return;
  }
  if (command === "deleteSelection") {
    await deleteSelection();
    return;
  }
  const node = filteredNodes.value.find((option) => option.type === command);
  if (!node) return;
  const handle = pendingHandle.value;
  const group = pendingGroup.value;
  if (handle && flow.findNode(handle.node.id) !== handle.node) return;
  if (group.some(source => flow.findNode(source.id) !== source)) return;
  const id = crypto.randomUUID();
  addNodes({ id, type: node.type, position: { ...nodePosition }, data: { label: node.label } });
  if (!handle && !group.length) {
    flow.removeSelectedElements();
    flow.nodesSelectionActive.value = false;
    const created = flow.findNode(id);
    if (created) flow.addSelectedNodes([created]);
    return menu.value?.handleClose();
  }
  // ACT: 远端节点挂载后才注册端口，沿用画布工具的 nextTick 等待方式。
  await nextTick();
  const created = flow.findNode(id);
  if (group.length) {
    if (!created) return;
    const connections = flow.nodesConnectable.value
      ? getSelectionConnections(group, created, flow.getNodes.value, flow.getEdges.value)
      : undefined;
    if (connections) {
      flow.addEdges(connections);
      flow.removeSelectedElements();
      flow.nodesSelectionActive.value = false;
      clearConnection();
      menu.value?.handleClose();
    } else {
      flow.removeNodes(id, true);
      flow.removeSelectedElements();
      flow.addSelectedNodes(group);
      flow.nodesSelectionActive.value = true;
      ElMessage.warning("该节点的接收规则不允许整组选中节点连接");
    }
    return;
  }
  if (!handle) return;
  if (!created || flow.findNode(handle.node.id) !== handle.node) {
    clearConnection();
    return menu.value?.handleClose();
  }
  const sourceNode = handle.type === "source" ? handle.node : created;
  const targetNode = handle.type === "target" ? handle.node : created;
  const connection = (created.data.handles as NodeHandle[] | undefined)
    ?.filter((item) => item.type !== handle.type)
    .map((item) => ({
      source: sourceNode.id,
      target: targetNode.id,
      sourceHandle: handle.type === "source" ? handle.id : item.id,
      targetHandle: handle.type === "target" ? handle.id : item.id,
    }))
    .find(
      (item) =>
        flow.nodesConnectable.value &&
        sourceNode.connectable !== false &&
        targetNode.connectable !== false &&
        validateConnection(item, { sourceNode, targetNode, nodes: flow.getNodes.value, edges: flow.getEdges.value })
    );
  if (connection) flow.addEdges(connection);
  else ElMessage.warning("节点已创建，但没有兼容的端口可连接");
  clearConnection();
  menu.value?.handleClose();
}

async function deleteSelection(selection = selectedNodes.value) {
  if (selectionBusy || deleting.value) return;
  const nodes = getSelectionTree(selection.filter(node => node.deletable !== false), flow.getNodes.value).reverse();
  const nodeIds = new Set(nodes.filter(node => node.deletable !== false).map(node => node.id));
  deleting.value = true;
  try {
    for (const node of nodes) {
      if (node.deletable === false || flow.findNode(node.id) !== node) continue;
      if (flow.getNodes.value.some(item => item.parentNode === node.id && !nodeIds.has(item.id))) throw new Error("分组中存在不可删除的节点");
      if (flow.getConnectedEdges(node.id).some((edge) => edge.deletable === false)) throw new Error("节点存在不可删除的连接");
    }
    for (const node of nodes) {
      if (node.deletable === false || flow.findNode(node.id) !== node) continue;
      await useNodeEvent(node.id, flow).emit("delete");
      if (flow.getNodes.value.some(item => item.parentNode === node.id)) throw new Error("分组内容已变化，请重新删除");
      if (flow.findNode(node.id) === node) flow.removeNodes(node.id, true);
    }
    menu.value?.handleClose();
  } catch (error) {
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    ElMessage.error(message || (error instanceof Error ? error.message : "删除选中节点失败"));
  } finally {
    selectedNodes.value = selectedNodes.value.filter((node) => flow.findNode(node.id) === node);
    deleting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.nodeMenu {
  min-width: 180px;

  :deep(.el-divider--horizontal) {
    margin: 4px 0;
  }

  .nextIcon {
    margin-left: auto;
  }
}
</style>
