<!--
  Strands —— WebGL 流体丝带背景（原版是 React + ogl 的 `Strands` 组件）。

  这里做了三处**有意**的改造，都是为了让它在"画布节点里当背景"这个场景下站得住：

  1. **不用 `ogl`，直接写原生 WebGL2。**
     原版靠 `ogl` 提供 Renderer/Program/Mesh/Triangle 那套薄封装，实际用到的
     能力只有"编个程序 + 画一个全屏三角形 + 每帧改 uniform"。为一个背景给
     **所有节点**的依赖树里塞一个渲染库不划算 —— 而且 nodeScaffold 是被打包
     进每个节点包的，体积会翻倍。手写约 80 行就够。

  2. **去掉了 glass（玻璃折射）那一段 pass。**
     它需要离屏 RenderTarget + 二次采样，在 Pentium Gold + WebView2 上是纯粹的
     浪费：本场景只要"背景有在动"，不要球面折射。

  3. **加了降级与省电。** WebGL2 不可用 / 编译失败 → 不渲染 canvas，由父组件
     回退到纯 CSS 背景；`animated=false`（prefers-reduced-motion）→ 只画一帧静态
     画面；页面不可见时暂停 RAF。

  着色器逻辑与原版一致（丝带叠加 / 色相环取样 / 饱和度与发光后处理），
  只把 `MAX_STRANDS`、`MAX_COLORS` 保留为常量 —— 它们必须写死在 GLSL 里
  （ES 3.00 的 uniform 数组长度不能动态定）。
-->
<template>
  <!--
    ⚠️ 这里**不能**用 `v-if="ok"`：首次渲染时 ok 还是 false，canvas 压根不存在于
    DOM，onMounted 里 `canvas.value` 就是 null，于是永远走"初始化失败"分支 ——
    自锁。用 `v-show` 保证元素始终在 DOM 里，只是没就绪时先藏着。
  -->
  <canvas v-show="ok" ref="canvas" class="strandsCanvas" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{
  /** 调色板（hex）。丝带按色相环在相邻色之间插值。 */
  colors?: string[];
  /** 丝带条数（1–12）。 */
  count?: number;
  speed?: number;
  amplitude?: number;
  waviness?: number;
  thickness?: number;
  glow?: number;
  taper?: number;
  spread?: number;
  hueShift?: number;
  intensity?: number;
  saturation?: number;
  opacity?: number;
  scale?: number;
  /** false → 只绘制一帧（尊重 prefers-reduced-motion，不要动效）。 */
  animated?: boolean;
}>(), {
  colors: () => ["#7c3aed", "#ff9ffc", "#5227ff"],
  count: 3,
  speed: 0.5,
  amplitude: 1,
  waviness: 1,
  thickness: 0.7,
  glow: 2.6,
  taper: 3,
  spread: 1,
  hueShift: 0,
  intensity: 0.6,
  saturation: 1.5,
  opacity: 1,
  scale: 1.5,
  animated: true,
});

const emit = defineEmits<{ /** 初始化结果，父组件据此决定要不要显示 CSS 兜底背景 */ available: [boolean] }>();

const MAX_STRANDS = 12;
const MAX_COLORS = 8;

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;
uniform int uStrandCount;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaviness;
uniform float uThickness;
uniform float uGlow;
uniform float uTaper;
uniform float uSpread;
uniform float uHueShift;
uniform float uIntensity;
uniform float uOpacity;
uniform float uScale;
uniform float uSaturation;

out vec4 fragColor;

const float PI = 3.14159265;

vec3 spectrum(float t) {
  return 0.5 + 0.5 * cos(2.0 * PI * (t + vec3(0.00, 0.33, 0.67)));
}

vec3 samplePalette(float t) {
  t = fract(t);
  float scaled = t * float(uColorCount);
  int idx = int(floor(scaled));
  float blend = fract(scaled);
  int nextIdx = idx + 1;
  if (nextIdx >= uColorCount) nextIdx = 0;
  return mix(uColors[idx], uColors[nextIdx], blend);
}

vec3 strandColor(float t) {
  if (uColorCount > 0) return samplePalette(t);
  return spectrum(t);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  uv /= max(uScale, 0.0001);

  float e = 0.06 + uIntensity * 0.94;
  float env = pow(max(cos(uv.x * PI * 1.3), 0.0), uTaper);

  vec3 col = vec3(0.0);

  for (int i = 0; i < ${MAX_STRANDS}; i++) {
    if (i >= uStrandCount) break;

    float fi = float(i);
    float ph = fi * 1.7 * uSpread;
    float freq = (2.0 + fi * 0.35) * uWaviness;
    float spd = 1.4 + fi * 1.2;

    float tt = uTime * uSpeed;
    float w = sin(uv.x * freq + tt * spd + ph) * 0.60
            + sin(uv.x * freq * 1.1 - tt * spd * 0.7 + ph * 1.7) * 0.40;

    float amp = (0.1 + 0.02 * e) * env * uAmplitude;
    float y = w * amp;

    float d = abs(uv.y - y);
    float thick = (0.001 + 0.05 * e) * (0.35 + env) * uThickness;
    float g = thick / (d + thick * 0.45);
    g = g * g;

    float h = fi / float(uStrandCount) + uv.x * 0.30 + uTime * 0.04 + uHueShift;
    col += strandColor(h) * g * env;
  }

  col *= 0.45 + 0.7 * e;
  col = 1.0 - exp(-col * uGlow);

  float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(gray), col, uSaturation), 0.0);

  float lum = max(max(col.r, col.g), col.b);
  float alpha = clamp(lum, 0.0, 1.0) * uOpacity;

  fragColor = vec4(col * uOpacity, alpha);
}
`;

const canvas = ref<HTMLCanvasElement | null>(null);
const ok = ref(false);

let gl: WebGL2RenderingContext | null = null;
let raf = 0;
let observer: ResizeObserver | null = null;
let removeVisibility: (() => void) | null = null;

/** '#abc' / '#aabbcc' → [r,g,b]（0–1）。解析不出来就当白色，不至于让整块背景黑掉。 */
function toRgb(hex: string): [number, number, number] {
  const raw = String(hex || "").trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[\da-f]{6}$/i.test(full)) return [1, 1, 1];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** 补齐到 MAX_COLORS 个（不足的用最后一个色重复填），对齐原版行为。 */
function buildPalette(colors: string[]) {
  const list = colors && colors.length ? colors : ["#ffffff"];
  const out = new Float32Array(MAX_COLORS * 3);
  for (let i = 0; i < MAX_COLORS; i++) {
    const [r, g, b] = toRgb(list[Math.min(i, list.length - 1)]!);
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

function compile(glc: WebGL2RenderingContext, type: number, src: string) {
  const shader = glc.createShader(type);
  if (!shader) throw new Error("createShader 失败");
  glc.shaderSource(shader, src);
  glc.compileShader(shader);
  if (!glc.getShaderParameter(shader, glc.COMPILE_STATUS)) {
    const info = glc.getShaderInfoLog(shader);
    glc.deleteShader(shader);
    throw new Error(`着色器编译失败：${info}`);
  }
  return shader;
}

onMounted(() => {
  const el = canvas.value;
  if (!el) { emit("available", false); return; }

  gl = el.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,   // 片元输出的是预乘色，浏览器直接合成
    antialias: false,           // 全屏三角形 + 无深度，抗锯齿无意义
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) { emit("available", false); return; }

  const glc = gl;
  let program: WebGLProgram | null = null;
  const uniforms: Record<string, WebGLUniformLocation | null> = {};

  try {
    program = glc.createProgram();
    if (!program) throw new Error("createProgram 失败");
    const vs = compile(glc, glc.VERTEX_SHADER, VERT);
    const fs = compile(glc, glc.FRAGMENT_SHADER, FRAG);
    glc.attachShader(program, vs);
    glc.attachShader(program, fs);
    // 显式钉住 attribute 位置，避免去猜编译器分配了哪一号
    glc.bindAttribLocation(program, 0, "position");
    glc.linkProgram(program);
    glc.deleteShader(vs);
    glc.deleteShader(fs);
    if (!glc.getProgramParameter(program, glc.LINK_STATUS)) {
      throw new Error(`程序链接失败：${glc.getProgramInfoLog(program)}`);
    }
    glc.useProgram(program);

    for (const name of [
      "uTime", "uResolution", "uColors[0]", "uColorCount", "uStrandCount", "uSpeed",
      "uAmplitude", "uWaviness", "uThickness", "uGlow", "uTaper", "uSpread",
      "uHueShift", "uIntensity", "uOpacity", "uScale", "uSaturation",
    ]) {
      // 数组 uniform 有的实现要 "uColors[0]"，有的认 "uColors"
      const loc = glc.getUniformLocation(program, name)
        ?? (name.endsWith("[0]") ? glc.getUniformLocation(program, name.slice(0, -3)) : null);
      if (loc) uniforms[name] = loc;
    }

    // 全屏三角形（比两个三角形省一个顶点，且没有对角线接缝）
    const buffer = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, buffer);
    glc.bufferData(glc.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), glc.STATIC_DRAW);
    glc.enableVertexAttribArray(0);
    glc.vertexAttribPointer(0, 2, glc.FLOAT, false, 0, 0);
    // 关掉混合：片元已经是预乘色，直接在清空后的缓冲上覆写即可（等价于 ONE/ONE_MINUS_SRC_ALPHA 叠在透明底上）
    glc.disable(glc.BLEND);
    glc.clearColor(0, 0, 0, 0);
  } catch (err) {
    console.warn("[strandsBackdrop] 初始化失败，回退 CSS 背景：", err);
    emit("available", false);
    return;
  }

  function applyUniforms(timeMs: number) {
    const g = glc;
    const u = (n: string) => uniforms[n];
    g.uniform1f(u("uTime")!, timeMs / 1000);
    g.uniform2f(u("uResolution")!, g.canvas.width, g.canvas.height);
    g.uniform3fv(u("uColors[0]")!, buildPalette(props.colors));
    g.uniform1i(u("uColorCount")!, Math.min(props.colors.length || 1, MAX_COLORS));
    g.uniform1i(u("uStrandCount")!, Math.min(Math.max(1, Math.round(props.count)), MAX_STRANDS));
    g.uniform1f(u("uSpeed")!, props.speed);
    g.uniform1f(u("uAmplitude")!, props.amplitude);
    g.uniform1f(u("uWaviness")!, props.waviness);
    g.uniform1f(u("uThickness")!, props.thickness);
    g.uniform1f(u("uGlow")!, props.glow);
    g.uniform1f(u("uTaper")!, props.taper);
    g.uniform1f(u("uSpread")!, props.spread);
    g.uniform1f(u("uHueShift")!, props.hueShift);
    g.uniform1f(u("uIntensity")!, props.intensity);
    g.uniform1f(u("uOpacity")!, props.opacity);
    g.uniform1f(u("uScale")!, props.scale);
    g.uniform1f(u("uSaturation")!, props.saturation);
  }

  function draw(timeMs: number) {
    glc.clear(glc.COLOR_BUFFER_BIT);
    applyUniforms(timeMs);
    glc.drawArrays(glc.TRIANGLES, 0, 3);
  }

  function resize() {
    const host = el!.parentElement ?? el!;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    // ⚠️ 必须按 DPR 设 canvas 的位图尺寸，否则在缩放屏上整块背景是糊的。
    //    上限 2：更高只会拉高填充率，肉眼看不出差别（本机 Pentium Gold）。
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (el!.width === bw && el!.height === bh) return false;
    el!.width = bw;
    el!.height = bh;
    glc.viewport(0, 0, bw, bh);
    return true;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animated = props.animated && !reduced;

  resize();
  applyUniforms(0);
  draw(0);
  ok.value = true;
  emit("available", true);

  if (animated) {
    const start = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      resize();
      draw(now - start);
    };
    raf = requestAnimationFrame(loop);

    // 页面不可见 / 节点被移出视口时停掉 RAF，别白烧 CPU
    const onVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
  }

  // 节点会被用户拖动缩放 —— 必须监听**容器**尺寸变化，只盯 window resize 是不够的
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (resize() && !animated) draw(0);
    });
    observer.observe(el.parentElement ?? el);
  }
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  observer?.disconnect();
  observer = null;
  removeVisibility?.();
  removeVisibility = null;
  // 主动释放上下文：画布会被反复挂载/卸载，不释放会攒够上限把整页 WebGL 拖死
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  gl = null;
});
</script>

<style scoped>
.strandsCanvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
