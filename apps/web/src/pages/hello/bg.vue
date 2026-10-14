<template>
  <div class="bgArt" aria-hidden="true">
    <div class="film">
      <!-- 影片本体：**直接播原片**（原生播放管线，GPU 解码/合成，JS 零逐帧工作）。
           老胶片的感觉全部由下面这几层 CSS 覆盖层提供。 -->
      <video ref="filmVideo" class="filmVideo" :src="filmUrl" muted loop playsinline autoplay preload="auto" />
      <span class="rail railLeft" />
      <span class="rail railRight" />
      <span class="leak" />
      <span class="scratch" />
      <span class="scratch scratchAlt" />
      <span class="vignette" />
      <span class="grain" :style="{ backgroundImage: `url(${grainUrl})` }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import filmUrl from "@/assets/silent-film.mp4";
import grainUrl from "@/assets/film-grain.png";

/**
 * 首屏右侧的「老胶片」动画。
 *
 * ⚠️ 这里刻意**不**用 canvas 逐帧重绘：
 *    · 早先用 canvas 画（先 16 张精灵图、后改成 drawImage(video)）时，每帧都要在
 *      主线程上做 drawImage + 齿孔 + 颗粒 soft-light 合成，低配机（Pentium Gold + 集显）
 *      上表现为「卡」「播放不流畅」；把帧率降到 15fps 能救回来，但画面又开始跳。
 *    · 现在的做法是用户点出来的正解：**视频交给 <video> 原生播**（硬件解码 + 合成器，
 *      主线程零负担、帧率就是原片的 30fps），胶片质感（片轨齿孔、颗粒、划痕、
 *      暗角、灯光泄漏、轻微跳帧抖动）用 CSS 覆盖层做 —— 全是 transform/opacity，
 *      走合成器线程，几乎不占 CPU。
 *    要再加胶片味，就往这一叠 span 上叠，别再回到 canvas 每帧重绘的老路。
 */
const filmVideo = ref<HTMLVideoElement>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** 系统开了「减少动效」就别自动播放（CSS 动画也在样式里一并关掉）。 */
function syncMotion() {
  const video = filmVideo.value;
  if (!video) return;
  if (reducedMotion.matches) video.pause();
  else void video.play().catch(() => undefined);
}

onMounted(() => {
  syncMotion();
  reducedMotion.addEventListener("change", syncMotion);
});
onBeforeUnmount(() => reducedMotion.removeEventListener("change", syncMotion));
</script>

<style lang="scss" scoped>
.bgArt {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  pointer-events: none;
  /* 原来 canvas 里那圈"投影光晕"：中心暖灰、四周压到近黑。 */
  background: radial-gradient(circle at 50% 50%, #77766f 0%, #242525 55%, #101112 100%);
}

.film {
  position: relative;
  /* 胶片窗口尺寸 = 原公式 min(宽×0.94, 高×0.8×181/125) 再 **缩小 15%**（用户要求）：
       宽：0.94 × 0.85            = 79.9%
       高：0.8 × 181/125 × 0.85   = 0.985 → 折算成"容器高度（100vh-16px）的 98.5%" */
  width: min(79.9%, calc((100vh - 16px) * 0.985));
  aspect-ratio: 181 / 125;
  overflow: hidden;
  border-radius: 5px;
  background: #131414;
  /* 画格外沿的黑描边 + 投影（原来靠 canvas 的 strokeRect + shadowBlur）。 */
  box-shadow: 0 0 0 3px rgb(8 9 8 / 50%), 0 22px 48px rgb(0 0 0 / 50%);
  /* 胶片跳帧的轻微位移/旋转 —— transform 动画在合成器上跑，代价可忽略。 */
  animation: filmJitter 0.36s steps(2, end) infinite;

  .filmVideo {
    position: absolute;
    /* 左右各留 6% 给片轨，正好复刻原来 181:125 画格里的成像区。 */
    inset: 0 6% 0 6%;
    width: 88%;
    height: 100%;
    /* 影片是 16:9、画格是 181:125 ⇒ contain：完整显示整幅画面，上下留一点暗边。 */
    object-fit: contain;
    background: #0c0d0d;
  }

  /* ---------- 片轨 + 齿孔：黑轨上一排深色圆孔，按 15px 一节重复 ---------- */
  .rail {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6%;
    background-color: #1c1c1c;
    background-image: radial-gradient(circle 4px at 50% 7.5px, rgb(5 5 5 / 78%) 0 68%, rgb(255 255 255 / 7%) 72% 100%, transparent 100%);
    background-size: 100% 15px;
    background-repeat: repeat-y;
  }
  .railLeft {
    left: 0;
  }
  .railRight {
    right: 0;
  }

  /* ---------- 老胶片滤镜层（全部叠在视频之上） ---------- */

  /* 暖色灯光泄漏，缓慢起伏 */
  .leak {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 85% 12%, rgb(255 150 60 / 20%), transparent 58%);
    animation: leakBreathe 7s ease-in-out infinite;
  }

  /* 偶发划痕：两条细竖线，各自按不同周期闪一下并轻微移动 */
  .scratch {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 58%;
    width: 1px;
    background: linear-gradient(to bottom, transparent, rgb(255 249 229 / 40%) 22%, rgb(255 249 229 / 16%) 72%, transparent);
    opacity: 0;
    animation: scratchFlash 6.5s steps(1, end) infinite;
  }
  .scratchAlt {
    left: 31%;
    width: 2px;
    background: linear-gradient(to bottom, transparent, rgb(18 20 19 / 45%) 30%, transparent 80%);
    animation-duration: 9.5s;
    animation-delay: 2.4s;
  }

  /* 暗角 */
  .vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 47% 46%, rgb(255 248 229 / 4%) 0%, rgb(0 0 0 / 3%) 50%, rgb(0 0 0 / 28%) 82%, rgb(0 0 0 / 79%) 100%);
  }

  /* 颗粒：一张静态噪点贴图 + 两帧一跳的位移（soft-light 让它只加质感、不改色） */
  .grain {
    position: absolute;
    /* 放大一圈，位移时不会露出边缘。 */
    inset: -10%;
    background-repeat: repeat;
    background-size: 160px 160px;
    mix-blend-mode: soft-light;
    opacity: 0.42;
    animation: grainShift 0.4s steps(2, end) infinite;
  }
}

@keyframes filmJitter {
  0% {
    transform: translate3d(0, 0, 0) rotate(0deg);
  }
  50% {
    transform: translate3d(0.7px, -0.9px, 0) rotate(0.05deg);
  }
  100% {
    transform: translate3d(-0.6px, 0.8px, 0) rotate(-0.04deg);
  }
}

@keyframes grainShift {
  0% {
    transform: translate3d(0, 0, 0);
  }
  100% {
    transform: translate3d(-13px, 9px, 0);
  }
}

@keyframes leakBreathe {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 0.95;
  }
}

@keyframes scratchFlash {
  0%,
  86%,
  100% {
    opacity: 0;
    transform: translateX(0);
  }
  87%,
  94% {
    opacity: 0.85;
    transform: translateX(-15px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .film,
  .film .grain,
  .film .leak,
  .film .scratch {
    animation: none;
  }
  .film .scratch {
    opacity: 0;
  }
}
</style>
