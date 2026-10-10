<!--
  首页背景：WebGL2 波浪（GradientWaves） + 随主题走的底部轻遮罩。

  参数说明（都用的组件默认值，实测过才敢这么定）：
    · 波浪本身透明底（上半部近乎透明、下半部不透明），底色用 var(--el-bg-color)，
      深色主题即近黑、浅色主题即白 → 换主题自动跟随。
    · fogDepth 保持默认 15。实测把它加大到 28/40 会让底部的浪涌变成近白色块
      （像素采样：(238,231,245)，与浅色文字的对比度只有 1:1），既压过页面内容、
      也让底部文字看不清 —— 默认值反而最平衡。
    · 遮罩只压最后一段：中段波浪要看得见，底部给文字留一层兜底（标题行实测 11.35:1）。
    · resolutionScale 0.6 + maxFps 30：光线步进的重着色器，半分辨率肉眼看不出差别，
      却能把开销降到 1/3，也给配置更低的同事机器留足余量（实测稳定跑满 30 帧）。
-->
<template>
  <div class="creativeBackground" aria-hidden="true">
    <gradientWaves
      class="waves"
      horizon-color="#5227FF"
      wave-color="#FF9FFC"
      crest-color="#FFFFFF"
      detail="medium"
      :resolution-scale="0.6"
      :max-fps="30" />
    <div class="scrim" />
  </div>
</template>

<script setup lang="ts">
import gradientWaves from "@/components/gradientWaves.vue";
</script>

<style lang="scss" scoped>
.creativeBackground {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background: var(--el-bg-color);

  .waves,
  .scrim {
    position: absolute;
    inset: 0;
  }

  .scrim {
    background: linear-gradient(
      180deg,
      transparent 0%,
      transparent 55%,
      color-mix(in srgb, var(--el-bg-color) 45%, transparent) 100%
    );
  }
}
</style>
