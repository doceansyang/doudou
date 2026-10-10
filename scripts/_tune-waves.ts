// 波浪背景调参台：一次跑多组参数、各出一张图，用眼睛＋像素数据一起选。
//
// 关键点：着色器**直接从 gradientWaves.vue 里抽出来**（正则取模板字符串），
// 所以这里试出来的效果与线上组件完全一致，不存在"调参台和实际不是一个 shader"的偏差。
// 背景色铺成软件深色底（#17171a），因为真实观感是「波浪叠在深色页面底上」，不能只看透明底。
//
// 用法：bun scripts/_tune-waves.ts
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow";
const OUT = join(PROJECT, "scripts", "_out");
const VUE = join(PROJECT, "apps", "web", "src", "components", "gradientWaves.vue");
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const source = readFileSync(VUE, "utf-8");
const vertex = /const VERTEX_SHADER = `([\s\S]*?)`;/.exec(source)?.[1];
const fragment = /const FRAGMENT_SHADER = `([\s\S]*?)`;/.exec(source)?.[1];
if (!vertex || !fragment) {
  console.log("✗ 没能从 gradientWaves.vue 里抽出着色器");
  process.exit(1);
}

// 基线＝组件默认值；每组只写要改的字段
const BASE = {
  horizonColor: "#5227FF", waveColor: "#FF9FFC", crestColor: "#FFFFFF",
  speed: 0.4, amplitude: 2.5, waveScale: 0.6, waveRatio: 0.9, swell: 35, turbulence: 20,
  tilt: 1.11, zoom: 1.0, height: 5.5, fogDepth: 15, steps: 40,
  brightness: 1.0, opacity: 1.0, grain: 1, grainIntensity: 0.05,
};

const VARIANTS: Array<[string, Record<string, number | string>]> = [
  ["A-默认", {}],
  ["B-雾深28", { fogDepth: 28 }],
  ["C-雾深28+亮1.25", { fogDepth: 28, brightness: 1.25 }],
  ["D-雾深40+亮1.15", { fogDepth: 40, brightness: 1.15 }],
  ["E-倾角0.75+雾深32", { tilt: 0.75, fogDepth: 32 }],
  ["F-雾深40+倾角0.85+亮1.2", { fogDepth: 40, tilt: 0.85, brightness: 1.2 }],
];

const executablePath = CANDIDATES.find(p => existsSync(p));
if (!executablePath) { console.log("✗ 找不到浏览器"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const page_html = (params: Record<string, unknown>) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; background: #17171a; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style></head><body>
<canvas id="c"></canvas>
<script>
const VERTEX = ${JSON.stringify(vertex)};
const FRAGMENT = ${JSON.stringify(fragment)};
const P = ${JSON.stringify({ ...BASE, ...params })};
const hex = h => { const m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(h); return m ? [1,2,3].map(i => parseInt(m[i],16)/255) : [1,1,1]; };

const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn("GLSL:" + gl.getShaderInfoLog(s)); return s; };
const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
gl.linkProgram(program);
gl.useProgram(program);
const L = n => gl.getUniformLocation(program, n);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.clearColor(0,0,0,0);
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

const dpr = Math.min(window.devicePixelRatio || 1, 2) * 0.6;
canvas.width = Math.floor(innerWidth * dpr);
canvas.height = Math.floor(innerHeight * dpr);
gl.viewport(0, 0, canvas.width, canvas.height);

const f = (n, v) => gl.uniform1f(L(n), v);
gl.uniform2f(L("iResolution"), canvas.width, canvas.height);
f("uSpeed", P.speed); f("uAmplitude", P.amplitude); f("uWaveScale", P.waveScale);
f("uWaveRatio", P.waveRatio); f("uSwell", P.swell); f("uTurbulence", P.turbulence);
f("uTilt", P.tilt); f("uZoom", P.zoom); f("uHeight", P.height); f("uFogDepth", P.fogDepth);
f("uSteps", P.steps); f("uBrightness", P.brightness); f("uOpacity", P.opacity);
f("uGrain", P.grain); f("uGrainIntensity", P.grainIntensity); f("uParallax", 0.5);
gl.uniform1i(L("uEnableMouse"), 0);
gl.uniform2f(L("uMouse"), 0.5, 0.5);
gl.uniform3f(L("uHorizonColor"), ...hex(P.horizonColor));
gl.uniform3f(L("uWaveColor"), ...hex(P.waveColor));
gl.uniform3f(L("uCrestColor"), ...hex(P.crestColor));

// 不跑动画，只画**同一时刻**的一帧（t=6s）—— 各组参数必须在同一时间点比较，
// 否则比的是"不同瞬间的波浪"而不是"不同参数的效果"。
gl.uniform1f(L("iTime"), 6.0);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 3);
window.__ready = true;
</script></body></html>`;

const browser = await chromium.launch({ executablePath, headless: false, args: ["--window-position=60,60"] });
const report: string[] = [];

try {
  for (const [name, params] of VARIANTS) {
    // 每组开一个全新页面：同一个页面反复 setContent 会累积 WebGL 上下文，
    // Chrome 达到上限后会丢掉旧上下文，后面的组就渲染成一片黑（踩过）。
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", message => {
      if (/GLSL|WebGL|context/i.test(message.text())) console.log("    [页面] " + message.text());
    });
    try {
      await page.setContent(page_html(params), { waitUntil: "load" });
      await page.waitForTimeout(900);
      const file = join(OUT, `waves-${name}.png`);
      await page.screenshot({ path: file });
      report.push(`${name}  ${JSON.stringify(params)}`);
      console.log("✓ " + name);
    } finally {
      await page.close();
    }
  }
} catch (error) {
  console.log("✗ " + String(error).split("\n")[0]);
} finally {
  writeFileSync(join(OUT, "waves-tune.log"), report.join("\n") + "\n", "utf-8");
  await browser.close();
}
