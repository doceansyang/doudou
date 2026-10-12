<!--
  生成中遮罩 —— 长耗时的"正在出片"状态。

  为什么自己做而不是继续用 `v-loading`：
  Element Plus 的 loading 只是一个转圈遮罩，**没有任何进度感**。而视频生成要跑
  1～3 分钟，用户看不到"在往前走"就会怀疑卡死、反复点生成。主流同类工具
  （Sora / 可灵 / 即梦）在这一点上的做法是一致的：**一个持续爬升的百分比 +
  一块会动的背景**。

  ⚠️ 百分比是**合成**的，不是真实进度。原因：供应商接口（`POST /generate` 领任务号 →
  `GET /generate/result` 长轮询）只在**结束时**返回结果，中途拿不到任何进度。
  所以这里用一条「渐近逼近」曲线代替：起手快、越接近 99 越慢，永远不会自己在
  99 卡死之后假装到 100 —— 只有 `active` 变 false（真的拿到结果）才收口到 100。
  这一点很重要：**宁可停在 99 也不要撒谎**，用户看到 100% 却不出片会失去信任。

  视觉只用了 CSS 的位移动画（渐变 + transform），没有用 `filter: blur()`
  铺大面积 —— 本机是 Pentium Gold + WebView2，大范围模糊会明显掉帧。
  径向渐变本身就是柔和的，不需要模糊滤镜。
-->
<template>
  <transition name="genFade">
    <div
      v-if="mounted"
      class="genOverlay"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(shown)"
      :aria-label="label"
    >
      <div class="genBackdrop" aria-hidden="true">
        <span class="genBlob genBlob--a" />
        <span class="genBlob genBlob--b" />
        <span class="genGrid" />
        <span class="genSweep" />
      </div>

      <div class="genBody">
        <p class="genPercent">
          {{ Math.round(shown) }}<span class="genUnit">%</span>
        </p>
        <div class="genTrack">
          <span class="genFill" :style="{ transform: `scaleX(${shown / 100})` }" />
        </div>
        <p class="genLabel">{{ shown >= 100 ? doneLabel : label }}</p>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { onScopeDispose, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  /** 是否正在生成。变 true 开始爬升，变 false 收口到 100% 并淡出。 */
  active: boolean;
  label?: string;
  /** 收到结果、收口到 100% 那一小段时间的文案。 */
  doneLabel?: string;
  /** 爬升上限。留 1% 的余量，避免"到了 100 却还没出片"。 */
  ceiling?: number;
  /**
   * 逼近速度（毫秒，越大越慢）。26000 对应的手感：
   * 10 秒 ≈ 32%、30 秒 ≈ 68%、60 秒 ≈ 89%、180 秒 ≈ 99%。
   */
  tau?: number;
}>(), { label: "正在生成视频…", doneLabel: "已完成，正在载入…", ceiling: 99, tau: 26000 });

const mounted = ref(false);
const shown = ref(0);
let raf = 0;
let startedAt = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;

function stopRaf() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

/** 渐近曲线：t 越大越接近 ceiling，但永远不超过它。 */
function tick(now: number) {
  shown.value = props.ceiling * (1 - Math.exp(-(now - startedAt) / props.tau));
  raf = requestAnimationFrame(tick);
}

function start() {
  stopRaf();
  clearTimeout(holdTimer);
  shown.value = 0;
  mounted.value = true;
  // 等一帧再计时：否则首个绘制帧已经跑到 1~2%，看不到"从 0 开始"
  requestAnimationFrame(() => {
    startedAt = performance.now();
    raf = requestAnimationFrame(tick);
  });
}

function finish() {
  stopRaf();
  shown.value = 100;   // 收口，给"完成"一个明确信号
  holdTimer = setTimeout(() => { mounted.value = false; }, 480);
}

watch(() => props.active, (on) => {
  if (on) start();
  else if (mounted.value) finish();
}, { immediate: true });

onScopeDispose(() => {
  stopRaf();
  clearTimeout(holdTimer);
});
</script>

<style scoped lang="scss">
.genOverlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: inherit;
  // 让字号/间距跟着节点尺寸缩放；不支持的浏览器用上面各处的固定值兜底
  container-type: size;
}

/* ── 会动的背景 ──────────────────────────────────────────────
   底色压到近黑（#0b0713），只让两个品牌色光斑在上面漂 —— 这样白色文字
   在任何主题下都能保持 ≥ 7:1 对比度（实测本机截图取样）。 */
.genBackdrop {
  position: absolute;
  inset: 0;
  background: #0b0713;
}

.genBlob {
  position: absolute;
  width: 86%;
  aspect-ratio: 1;
  border-radius: 50%;
  will-change: transform;
}

.genBlob--a {
  top: -22%;
  left: -14%;
  background: radial-gradient(circle at 50% 50%, rgb(82 39 255 / 62%) 0%, rgb(82 39 255 / 0%) 68%);
  animation: genDriftA 17s ease-in-out infinite alternate;
}

.genBlob--b {
  right: -18%;
  bottom: -26%;
  background: radial-gradient(circle at 50% 50%, rgb(255 159 252 / 46%) 0%, rgb(255 159 252 / 0%) 66%);
  // 周期与 A 互质（17/23），两个光斑不会周期性"对齐"，画面不显得在循环
  animation: genDriftB 23s ease-in-out infinite alternate;
}

/* 细网格：给"正在逐帧渲染"的科技感，透明度压到 5% 只做肌理，不抢内容 */
.genGrid {
  position: absolute;
  inset: -20%;
  background-image:
    repeating-linear-gradient(0deg, rgb(255 255 255 / 5%) 0 1px, transparent 1px 34px),
    repeating-linear-gradient(90deg, rgb(255 255 255 / 5%) 0 1px, transparent 1px 34px);
  mask-image: radial-gradient(circle at 50% 50%, #000 30%, transparent 76%);
}

/* 一道斜向高光缓慢扫过 —— 电影感的那一下 */
.genSweep {
  position: absolute;
  inset: -40%;
  background: linear-gradient(
    104deg,
    transparent 42%,
    rgb(255 255 255 / 7%) 47%,
    rgb(255 255 255 / 13%) 50%,
    rgb(255 255 255 / 7%) 53%,
    transparent 58%
  );
  animation: genSweep 3.6s linear infinite;
}

.genBody {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 16px;
  text-align: center;
  color: #fff;
}

.genPercent {
  display: flex;
  align-items: baseline;
  gap: 1px;
  margin: 0;
  font-size: 34px;                                   // 兜底（不支持容器查询时）
  font-size: clamp(24px, 20cqmin, 60px);
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.02em;
  // 关键：数字宽度恒定，41% → 42% 时整个数字块不会左右抖动
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  text-shadow: 0 2px 26px rgb(88 40 255 / 60%);
}

.genUnit {
  font-size: 0.44em;
  font-weight: 500;
  opacity: 0.7;
}

.genTrack {
  width: min(64%, 240px);
  height: 3px;
  margin-top: 14px;
  // ⚠️ 这里**不能**用 overflow:hidden：轨道只有 3px 高，会把填充那圈前缘辉光
  //    垂直方向整个裁掉，等于白加。填充自己带了圆角，不需要轨道来裁。
  overflow: visible;
  // 内描边：小尺寸下轨道本身很细，靠这一圈让"还有多少没走完"看得清
  background: rgb(255 255 255 / 14%);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 8%);
  border-radius: 999px;
}

.genFill {
  display: block;
  width: 100%;
  height: 100%;
  transform: scaleX(0);
  transform-origin: left center;
  background: linear-gradient(90deg, #5227ff, #ff9ffc);
  border-radius: inherit;
  // 前缘辉光：让"正在往前推"这件事有体积感，而不是一条干巴巴的线
  box-shadow: 0 0 10px rgb(255 159 252 / 70%);
}

.genLabel {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: rgb(255 255 255 / 74%);
  letter-spacing: 0.02em;
}

/* 淡入淡出：出场稍慢一点，让"完成"有一拍喘息 */
.genFade-enter-active { transition: opacity 0.24s ease; }
.genFade-leave-active { transition: opacity 0.34s ease; }
.genFade-enter-from,
.genFade-leave-to { opacity: 0; }

@keyframes genDriftA {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(26%, 18%, 0) scale(1.16); }
}

@keyframes genDriftB {
  from { transform: translate3d(0, 0, 0) scale(1.12); }
  to { transform: translate3d(-22%, -16%, 0) scale(1); }
}

@keyframes genSweep {
  from { transform: translate3d(-38%, 0, 0); }
  to { transform: translate3d(38%, 0, 0); }
}

/* 尊重系统的"减少动态效果"：停掉装饰性动画，
   但百分比照常爬 —— 那是信息，不是装饰，不能一起关掉。 */
@media (prefers-reduced-motion: reduce) {
  .genBlob,
  .genSweep { animation: none; }

  .genFade-enter-active,
  .genFade-leave-active { transition-duration: 0.01s; }
}
</style>
