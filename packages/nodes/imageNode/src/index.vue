<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected && editor?.mode === 'inpaint'"
    :bottomWidth="660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <el-button :icon="IconBrush" :disabled="uploading || !previewUrl || gridSplit?.splitting" text title="局部重绘" aria-label="局部重绘" @click.stop="editor?.start('inpaint')">局部重绘</el-button>
      <el-button :icon="IconLayoutGrid" :disabled="uploading || !previewUrl" :loading="gridSplit?.splitting" text title="宫格切分" aria-label="宫格切分" @click.stop="gridSplit?.open($event)">宫格切分</el-button>
      <el-button
        :icon="IconTransfer"
        :loading="uploading"
        text
        title="替换图片"
        aria-label="替换图片"
        @click.stop="fileInput?.click()">替换图片</el-button>
    </template>
    <template #topRightActions>
      <el-button :icon="IconPencil" :disabled="uploading || !previewUrl || gridSplit?.splitting" text title="标记" aria-label="标记" @click.stop="editor?.start('mark')" />
    </template>
    <div class="imageContent nopan">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :toolbarTarget="paintToolbar"
        :disabled="uploading"
        alt="节点图片"
        @load="resizeImage"
        @error="ElMessage.error('无法预览该图片')" />
      <input ref="fileInput" class="fileInput" type="file" accept="image/*" aria-label="选择图片" :disabled="uploading" @change="uploadImage" />
      <el-button
        v-if="!outputFile"
        class="uploadButton"
        text
        :loading="uploading"
        title="上传图片"
        aria-label="上传图片"
        @dblclick.stop
        @click="fileInput?.click()">
        <icon-upload v-if="!uploading" :size="48" stroke="1.5" />
      </el-button>
    </div>
    <template v-if="editor?.mode === 'inpaint'" #bottom>
      <div ref="inpaintTarget" />
    </template>
  </nodeSkeleton>
  <imageInpaintPrompt v-if="editor?.mode === 'inpaint'" ref="inpaintPrompt" :target="inpaintTarget" :generate="generateInpaint" :disabled="uploading" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :disabled="uploading" :active="node.selected" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { IconPhoto, IconUpload, IconTransfer, IconLayoutGrid, IconBrush, IconPencil } from "@tabler/icons-vue";
import { ElButton, ElImageViewer, ElMessage } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle, type NodeImageRequest } from "@toonflow/nodes-scaffold/runtime";
import imageGridSplit from "@toonflow/nodes-scaffold/imageGridSplit";
import imageEditor from "@toonflow/nodes-scaffold/imageEditor";
import imageInpaintPrompt from "@toonflow/nodes-scaffold/imageInpaintPrompt";

defineOptions({
  inheritAttrs: false,
  icon: IconPhoto,
  handles: [
    { id: "in", type: "target", dataType: "IMAGE", label: "来源图片" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, nodeEvent, files, updateNodeInternals } = useNode({
  label: "图片",
});
const fileInput = ref<HTMLInputElement>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const paintToolbar = ref<HTMLElement>();
const inpaintPrompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const inpaintTarget = ref<HTMLElement>();
const uploading = ref(false);
const previewVisible = ref(false);
const imageWidth = ref(0);

const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, "图片读取失败")
);

nodeEvent.on("save", () => {
  if (uploading.value || editor.value?.busy || inpaintPrompt.value?.generating) throw new Error("图片处理中，请完成后再切换或刷新节点");
});
nodeEvent.on("delete", () => {
  if (uploading.value || editor.value?.busy || inpaintPrompt.value?.generating) throw new Error("图片处理中，请稍后删除节点");
  uploading.value = true;
  return files.removeNodeFiles().finally(() => {
    uploading.value = false;
  });
});

nodeTools.register({
  name: "setImage",
  description: "选择工作区内已有的图片文件作为此节点的输出，path 使用工作区相对路径",
  parameters: z.strictObject({
    path: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/),
  }),
  async execute({ path, mimeType }, { signal }) {
    signal?.throwIfAborted();
    if (uploading.value || editor.value?.busy || inpaintPrompt.value?.generating) throw new Error("图片处理中，请稍后重试");
    uploading.value = true;
    try {
      const content = await files.getWorkspaceFiles().read(path);
      signal?.throwIfAborted();
      if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("图片不能为空且不能超过 100 MB");
      outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType } };
      return outputs.value.image;
    } finally {
      uploading.value = false;
    }
  },
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = 240 * image.naturalWidth / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

async function generateInpaint(input: Omit<NodeImageRequest, "directory" | "outputDirectory" | "images">, signal: AbortSignal) {
  if (!editor.value) throw new Error("请先进入局部重绘");
  const value = await editor.value.generate(input, signal);
  signal.throwIfAborted();
  outputs.value.image = { dataType: "IMAGE", value };
  editor.value?.cancel();
}

async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploading.value) return;
  if (!file.type.startsWith("image/")) return void ElMessage.error("请选择图片文件");
  if (!file.size || file.size > 100 * 1024 * 1024) return void ElMessage.error("图片不能为空且不能超过 100 MB");
  uploading.value = true;
  try {
    const url = await files.uploadFile(file);
    // ACT: 复制节点可能仍引用旧图片，替换输出不删除共享文件。
    outputs.value.image = { dataType: "IMAGE", value: { url, mimeType: file.type } };
  } catch (error) {
    showError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
</script>

<style scoped lang="scss">
.imageContent {
  min-height: 144px;

  .fileInput {
    display: none;
  }

  .uploadButton {
    width: 100%;
    height: 144px;
    padding: 0;
    color: var(--el-text-color-placeholder);

    &:hover {
      color: var(--el-color-primary);
    }
  }
}
</style>
