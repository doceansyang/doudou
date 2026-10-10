<!--
  GradientWaves —— WebGL2 全屏波浪背景（光线步进等离子体曲面）

  来源：用户提供的 React + ogl 版本，这里做**零依赖 Vue 3 移植**：
    · 不引入 ogl（项目是 Vue，装 React 依赖不划算），直接用原生 WebGL2 复刻同一套逻辑：
      ogl 的 Renderer/Program/Mesh/Triangle 本质就是「一个全屏三角形 + 一个片元着色器」，
      几何数据是 [-1,-1, 3,-1, -1,3]，几十行原生代码即可。
    · 片元着色器逐字保留（GLSL ES 3.00），只把 `in vec2 position` 补上 location 绑定。

  性能（重要，本项目机器是入门级核显）：
    这是一个「每像素几十步光线步进」的重着色器，全分辨率跑会明显掉帧。
    因此提供三个性能开关，默认按保守值给：resolutionScale（内部渲染分辨率倍率）、
    maxFps（上限帧率）、detail（步数档位）。另外：
      · 页面不可见 / 滚出视口 → 暂停渲染；
      · prefers-reduced-motion → 只画一帧静态图（不占用 GPU）；
      · 鼠标视差改为监听 window（宿主保持 pointer-events:none，不抢页面交互）。
  调试：需要看真实帧率时给 debug，或在 localStorage 写 jinyutv.bgDebug=1，会显示角标。
-->
<template>
  <div ref="host" class="gradientWaves" aria-hidden="true">
    <span v-if="badge" class="fpsBadge">{{ fps }} FPS</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  horizonColor?: string;
  waveColor?: string;
  crestColor?: string;
  speed?: number;
  amplitude?: number;
  waveScale?: number;
  waveRatio?: number;
  swell?: number;
  turbulence?: number;
  tilt?: number;
  zoom?: number;
  height?: number;
  fogDepth?: number;
  detail?: "low" | "medium" | "high";
  brightness?: number;
  opacity?: number;
  mouseInteraction?: boolean;
  parallaxStrength?: number;
  grain?: boolean;
  grainIntensity?: number;
  /** 内部渲染分辨率倍率（性能主开关，1 = 按 CSS 尺寸×dpr 渲染） */
  resolutionScale?: number;
  /** 帧率上限（0 = 不限制），给界面留出 GPU 余量 */
  maxFps?: number;
  /** 显示帧率角标 */
  debug?: boolean;
}>(), {
  horizonColor: "#5227FF",
  waveColor: "#FF9FFC",
  crestColor: "#FFFFFF",
  speed: 0.4,
  amplitude: 2.5,
  waveScale: 0.6,
  waveRatio: 0.9,
  swell: 35,
  turbulence: 20,
  tilt: 1.11,
  zoom: 1,
  height: 5.5,
  fogDepth: 15,
  detail: "low",
  brightness: 1,
  opacity: 1,
  mouseInteraction: true,
  parallaxStrength: 0.5,
  grain: true,
  grainIntensity: 0.05,
  resolutionScale: 0.6,
  maxFps: 30,
  debug: false,
});

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;

  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);

  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;

const UNIFORM_NAMES = [
  "iResolution", "iTime", "uSpeed", "uAmplitude", "uWaveScale", "uWaveRatio",
  "uSwell", "uTurbulence", "uTilt", "uZoom", "uHeight", "uFogDepth", "uSteps",
  "uBrightness", "uOpacity", "uGrain", "uGrainIntensity", "uMouse", "uParallax",
  "uEnableMouse", "uHorizonColor", "uWaveColor", "uCrestColor",
] as const;

const host = ref<HTMLDivElement>();
const fps = ref(0);
const badge = computed(() => {
  if (props.debug) return true;
  try { return localStorage.getItem("jinyutv.bgDebug") === "1"; } catch { return false; }
});

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [
    parseInt(result[1]!, 16) / 255,
    parseInt(result[2]!, 16) / 255,
    parseInt(result[3]!, 16) / 255,
  ];
}

function detailToSteps(detail: string): number {
  if (detail === "low") return 40;
  if (detail === "high") return 110;
  return 70;
}

let gl: WebGL2RenderingContext | undefined;
let program: WebGLProgram | undefined;
let locations: Record<string, WebGLUniformLocation | null> = {};
let canvas: HTMLCanvasElement | undefined;
let raf = 0;
let resizeObserver: ResizeObserver | undefined;
let intersectionObserver: IntersectionObserver | undefined;
let events: AbortController | undefined;
let rendered = 0;
let clockStart = 0;
let lastFrameAt = 0;
let framesInSample = 0;
let sampleStartedAt = 0;
let inView = true;
let pageVisible = true;
let reducedMotion = false;
const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 };

function compile(type: number, source: string): WebGLShader | undefined {
  if (!gl) return undefined;
  const shader = gl.createShader(type);
  if (!shader) return undefined;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[GradientWaves] 着色器编译失败：" + (gl.getShaderInfoLog(shader) || ""));
    gl.deleteShader(shader);
    return undefined;
  }
  return shader;
}

function writeUniforms() {
  if (!gl) return;
  const set1f = (name: string, value: number) => gl!.uniform1f(locations[name] ?? null, value);
  const set2f = (name: string, x: number, y: number) => gl!.uniform2f(locations[name] ?? null, x, y);
  const set3 = (name: string, rgb: [number, number, number]) => gl!.uniform3f(locations[name] ?? null, rgb[0], rgb[1], rgb[2]);

  set1f("uSpeed", props.speed);
  set1f("uAmplitude", props.amplitude);
  set1f("uWaveScale", props.waveScale);
  set1f("uWaveRatio", props.waveRatio);
  set1f("uSwell", props.swell);
  set1f("uTurbulence", props.turbulence);
  set1f("uTilt", props.tilt);
  set1f("uZoom", props.zoom);
  set1f("uHeight", props.height);
  set1f("uFogDepth", props.fogDepth);
  set1f("uSteps", detailToSteps(props.detail));
  set1f("uBrightness", props.brightness);
  set1f("uOpacity", props.opacity);
  set1f("uGrain", props.grain ? 1 : 0);
  set1f("uGrainIntensity", props.grainIntensity);
  set1f("uParallax", props.parallaxStrength);
  gl.uniform1i(locations.uEnableMouse ?? null, props.mouseInteraction && !reducedMotion ? 1 : 0);
  set2f("uMouse", pointer.x, pointer.y);
  set3("uHorizonColor", hexToRgb(props.horizonColor));
  set3("uWaveColor", hexToRgb(props.waveColor));
  set3("uCrestColor", hexToRgb(props.crestColor));
}

function draw() {
  if (!gl) return;
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function resize() {
  if (!gl || !canvas || !host.value) return;
  const rect = host.value.getBoundingClientRect();
  // dpr 上限 2，再乘内核渲染倍率 —— 光线步进的成本与像素数成正比，这是最有效的性能旋钮
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * props.resolutionScale;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  const changed = canvas.width !== width || canvas.height !== height;
  if (changed) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(locations.iResolution ?? null, width, height);
  }
  if (changed || rendered === 0) draw();
  rendered++;
}

function loop(now: number) {
  raf = requestAnimationFrame(loop);
  const minDelta = props.maxFps > 0 ? 1000 / props.maxFps : 0;
  if (minDelta && now - lastFrameAt < minDelta - 1) return;
  lastFrameAt = now;

  const hostRect = host.value?.getBoundingClientRect();
  const useMouse = props.mouseInteraction && !reducedMotion;
  const tx = useMouse ? pointer.targetX : 0.5;
  const ty = useMouse ? pointer.targetY : 0.5;
  pointer.x += 0.05 * (tx - pointer.x);
  pointer.y += 0.05 * (ty - pointer.y);
  gl!.uniform2f(locations.uMouse ?? null, pointer.x, pointer.y);
  gl!.uniform1f(locations.iTime ?? null, (now - clockStart) * 0.001);
  void hostRect;

  draw();

  framesInSample++;
  if (now - sampleStartedAt >= 1000) {
    fps.value = Math.round((framesInSample * 1000) / (now - sampleStartedAt));
    framesInSample = 0;
    sampleStartedAt = now;
  }
}

function start() {
  if (raf !== 0 || !inView || !pageVisible || reducedMotion) return;
  raf = requestAnimationFrame(loop);
}

function stop() {
  if (raf === 0) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

onMounted(() => {
  const element = host.value;
  if (!element) return;

  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  canvas = document.createElement("canvas");
  canvas.className = "gradientWavesCanvas";
  gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  }) ?? undefined;

  if (!gl) {
    // 没有 WebGL2 就静默退出，页面保留自己的底色，不报错打扰用户
    console.warn("[GradientWaves] 当前环境不支持 WebGL2，已跳过背景动画");
    canvas = undefined;
    return;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return;

  program = gl.createProgram() ?? undefined;
  if (!program) return;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[GradientWaves] 着色器链接失败：" + (gl.getProgramInfoLog(program) || ""));
    return;
  }
  gl.useProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  for (const name of UNIFORM_NAMES) locations[name] = gl.getUniformLocation(program, name);

  // 全屏三角形：ogl 的 Triangle 就是这个（[-1,-1] [3,-1] [-1,3]），一片覆盖整个视口
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.clearColor(0, 0, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 着色器输出的是预乘颜色

  element.appendChild(canvas);
  writeUniforms();
  clockStart = performance.now();
  sampleStartedAt = clockStart;
  resize();

  if (reducedMotion) {
    // 尊重「减少动态效果」：只画一帧静态画面，之后不再占用 GPU
    draw();
  } else {
    start();
  }

  resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(element);

  intersectionObserver = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? true;
    if (inView) start(); else stop();
  }, { threshold: 0 });
  intersectionObserver.observe(element);

  events = new AbortController();
  const options = { passive: true, signal: events.signal } as AddEventListenerOptions;

  // 鼠标视差：监听 window 而不是 canvas —— 宿主保持 pointer-events:none，
  // 背景不会抢走页面上任何点击/拖选。
  window.addEventListener("pointermove", (event: PointerEvent) => {
    if (event.pointerType === "touch" || reducedMotion || !host.value) return;
    const bounds = host.value.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    pointer.targetX = (event.clientX - bounds.left) / bounds.width;
    pointer.targetY = 1 - (event.clientY - bounds.top) / bounds.height;
  }, options);
  window.addEventListener("pointerleave", () => {
    pointer.targetX = 0.5;
    pointer.targetY = 0.5;
  }, options);
  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
    if (pageVisible) start(); else stop();
  }, options);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    stop();
    console.warn("[GradientWaves] WebGL 上下文丢失，已暂停背景动画");
  }, options);
});

watch(() => [
  props.horizonColor, props.waveColor, props.crestColor, props.speed, props.amplitude,
  props.waveScale, props.waveRatio, props.swell, props.turbulence, props.tilt, props.zoom,
  props.height, props.fogDepth, props.detail, props.brightness, props.opacity, props.grain,
  props.grainIntensity, props.mouseInteraction, props.parallaxStrength,
], () => {
  if (!gl) return;
  gl.useProgram(program ?? null);
  writeUniforms();
  draw();
});

watch(() => [props.resolutionScale, props.maxFps], () => resize());

onBeforeUnmount(() => {
  stop();
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  events?.abort();
  if (canvas) {
    canvas.remove();
    try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 忽略 */ }
  }
  gl = undefined;
  program = undefined;
  locations = {};
  canvas = undefined;
});
</script>

<style lang="scss" scoped>
.gradientWaves {
  position: absolute;
  inset: 0;
  overflow: hidden;

  :deep(.gradientWavesCanvas) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .fpsBadge {
    position: absolute;
    right: 8px;
    bottom: 8px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
}
</style>
