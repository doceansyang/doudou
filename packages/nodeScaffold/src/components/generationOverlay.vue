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

  背景是一层 **WebGL 流体丝带**（`strandsBackdrop.vue`，见该文件的说明）；
  WebGL 不可用时回退到纯 CSS 的光斑 + 网格 + 扫光，静态但不会是白板。
  CSS 那一组刻意没有用 `filter: blur()` 铺大面积 —— 本机是 Pentium Gold +
  WebView2，大范围模糊会明显掉帧，径向渐变本身就够柔。
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
        <!-- 主背景：WebGL 流体丝带（Strands）。拿不到 WebGL 时下面的 CSS 层顶上 -->
        <!--
          参数是**肉眼对比调出来的**（`_overlay-preview/variants.ts` 的对照栅格，
          看 scripts/_out/_strands-variants.png）：
          · 原版振幅只有 ~0.11，丝带全挤在中线上糊成一条亮带，像飞碟；
          · 振幅 2.4 会周期性地撑成大菱形，画面忽大忽小；
          · 定在 1.3 —— 三个相位下都稳定，丝带之间留得住缝隙、又不糊成一条。
          ⚠️ 调这组参数**必须看多个相位**：栅格第一版每个参数只截一帧，
            同一组参数换个时刻就从"蝠鲼"变"蝴蝶"，只截一帧的结论是假的。
        -->
        <strandsBackdrop
          :colors="strandColors"
          :count="3"
          :amplitude="1.3"
          :thickness="0.7"
          :intensity="0.4"
          :glow="2.0"
          :opacity="0.92"
          :animated="!reduceMotion"
          @available="strandsReady = $event"
        />
        <template v-if="!strandsReady">
          <span class="genBlob genBlob--a" />
          <span class="genBlob genBlob--b" />
          <span class="genGrid" />
          <span class="genSweep" />
        </template>

        <!-- 文字底衬。放在丝带之上、文字之下 -->
        <span class="genScrim" />
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
import strandsBackdrop from "./strandsBackdrop.vue";

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

/**
 * 背景丝带的配色 —— 取品牌紫→品红，第三个色回到蓝紫做过渡，
 * 让色相环插值始终落在品牌区间里（不像原版默认那样跑到红/黄/青上去）。
 */
const strandColors = ["#7c3aed", "#ff9ffc", "#4c1dff"];
/** WebGL 是否可用。false 时回退到纯 CSS 的静态渐变背景。 */
const strandsReady = ref(false);
const reduceMotion = typeof window !== "undefined"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
   底色压到近黑（#0b0713），上面跑 WebGL 流体丝带（Strands）。
   WebGL 拿不到时，退回下面那一组纯 CSS 光斑 —— 静态但不会是白板。 */
.genBackdrop {
  position: absolute;
  inset: 0;
  background: #0b0713;
}

/* 文字底下的一层暗罩。
   ⚠️ 不是装饰：丝带最亮的地方正好在画面中部，也就是文字所在处。
   不做这层罩子，白字压在亮紫丝带上对比度会掉到 4.5:1 以下（实测过）。
   为什么是**整幅**的椭圆而不是贴着文字的小块：小块会在亮带中间抠出一个显眼的
   黑洞，看着像没渲染好；整幅椭圆读起来是"暗角"，是刻意的。 */
.genScrim {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 78% 62% at 50% 50%,
    rgb(9 6 18 / 58%) 0%,
    rgb(9 6 18 / 30%) 52%,
    rgb(9 6 18 / 0%) 100%
  );
  pointer-events: none;
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
  // 自成层叠上下文：里面的 .genVeil 用 z-index:-1 时才会压在丝带之上、文字之下
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 16px;
  text-align: center;
  color: #fff;
}

/* 字号**
   用户要求"小一点，10 号字就行" —— 10 号 = 10pt ≈ 13px。
   原来是 clamp(24px, 20cqmin, 60px)，大字占掉整个画面，现在收成小号信息条。
   仍然按容器缩放（cqmin），但区间压缩到 12–14px，大小节点看着都一致。 */
.genPercent {
  display: flex;
  align-items: baseline;
  gap: 1px;
  margin: 0;
  font-size: 13px;                                   // 兜底（不支持容器查询时）
  font-size: clamp(12px, 4.2cqmin, 14px);
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.01em;
  // 关键：数字宽度恒定，41% → 42% 时整个数字块不会左右抖动
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  // 小字号下不需要 26px 的大光晕（那是给 60px 数字准备的），改成贴着字的柔光
  text-shadow: 0 1px 10px rgb(10 4 24 / 70%);
}

.genUnit {
  font-size: 0.72em;
  font-weight: 500;
  opacity: 0.7;
}

.genTrack {
  width: min(54%, 170px);
  height: 3px;
  margin-top: 9px;
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
  margin: 7px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: rgb(255 255 255 / 76%);
  letter-spacing: 0.02em;
  text-shadow: 0 1px 8px rgb(10 4 24 / 70%);
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
