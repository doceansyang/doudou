<template>
  <div class="messageMarkdown">
    <markdown
      v-for="(chunk, index) in chunks"
      :key="index + '-' + !!definitions"
      v-memo="[chunk, streaming && index === chunks.length - 1, codeOptions, directory, markdownLocale]"
      class="markdownChunk"
      :content="chunk"
      :mode="streaming && index === chunks.length - 1 ? 'streaming' : 'static'"
      :enableAnimate="false"
      :shikiOptions="shikiOptions"
      :codeOptions="codeOptions"
      :linkOptions="{ safetyCheck: false }"
      :cdnOptions="cdnOptions"
      :components="markdownOverlays"
      :nodeRenderers="nodeRenderers"
      :parseMarkdownIntoBlocks="definitions ? keepChunk : undefined"
      :locale="markdownLocale" />
  </div>
</template>

<script setup lang="ts">
import { computed, h } from "vue";
import { Markdown, parseMarkdownIntoBlocks } from "vue-stream-markdown";
import { MarkdownAstParser } from "@markmend/ast";
import type { CodeOptions, ImageNodeRendererProps, ShikiOptions } from "vue-stream-markdown";
import "vue-stream-markdown/index.css";
import "vue-stream-markdown/theme.css";
import markdownOverlays from "./markdownOverlays";
import markdownImage from "./markdownImage.vue";
import { markdownLocale } from "@/lib/i18n";

const { content, streaming = false, codeOptions, directory } = defineProps<{ content: string; streaming?: boolean; codeOptions?: CodeOptions; directory?: string }>();
const renderImage = (image: ImageNodeRendererProps) => h(markdownImage, { image, directory: directory! });
const nodeRenderers = computed(() => directory ? { image: renderImage } : {});
const shikiOptions: ShikiOptions = { theme: ["github-light", "github-dark"] };
const cdnOptions = { shiki: false } as const;
const keepChunk = (value: string) => [value];
const blocks = computed(() => parseMarkdownIntoBlocks(content));
const definitionParser = new MarkdownAstParser({ mode: "static" });
const isDefinition = (block: string) => /^ {0,3}\[(?!\^)[^\]\n]+\]:/.test(block)
  && definitionParser.markdownToAst(block).children.every(node => node.type === "definition");
const definitions = computed(() => blocks.value.length > 1 ? blocks.value.filter(isDefinition).join("\n\n") : "");
const chunks = computed(() => {
  if (blocks.value.length < 2) return blocks.value;
  const groups: string[] = [];
  let current = "";
  // ACT: 不拆语法块，稳定组不重渲染；单个语法块仍完整交给库处理。
  for (const block of blocks.value) {
    if (isDefinition(block)) continue;
    if (current && current.length + block.length > 8192) {
      groups.push(current);
      current = "";
    }
    current += block;
  }
  if (current) groups.push(current);
  // 定义放在组前，避免落入末尾尚未闭合的代码块。
  return definitions.value ? groups.map(group => `${definitions.value}\n\n${group}`) : groups;
});
</script>

<style scoped lang="scss">
.messageMarkdown {
  min-width: 0;

  .markdownChunk {
    --background: var(--el-bg-color);
    --foreground: var(--el-text-color-primary);
    --muted: var(--el-fill-color-light);
    --muted-foreground: var(--el-text-color-secondary);
    --border: var(--el-border-color-lighter);
    // ⚠️ 链接色绑的是 --primary。原来直接给 --el-color-primary，而本项目主色是近黑的
    //    #171717 —— 深色主题下链接就渲染成黑字，在 #141414 的底上对比度只有 1.03:1，
    //    等于看不见（供应商说明里的「注册链接」整行消失）。
    //    改绑 --ui-brand-foreground：那是 App.vue 按主题算好的「可读品牌色」
    //    （深色下近黑主色会被提亮成浅灰，浅色下原样保留深色）→ 随主题自动适配。
    --primary: var(--ui-brand-foreground, var(--el-color-primary));
    font-size: inherit;
    line-height: inherit;

    & + .markdownChunk {
      margin-top: 12px;
    }
  }
}
</style>
