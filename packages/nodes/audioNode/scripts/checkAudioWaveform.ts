// 运行：bun packages/nodes/audioNode/scripts/checkAudioWaveform.ts
import assert from "node:assert/strict";
import { getWaveformPeaks } from "../src/audioWaveform";

assert.deepEqual(getWaveformPeaks([new Float32Array(7)], 4), [0, 0, 0, 0], "静音保持零高度");
assert.deepEqual(getWaveformPeaks([], 3), [0, 0, 0], "没有声道时保持固定条数");
assert.deepEqual(getWaveformPeaks([new Float32Array()], 2), [0, 0], "空采样不生成假波形");
assert.equal(getWaveformPeaks([]).length, 128, "默认返回 128 条");
assert.deepEqual(getWaveformPeaks([new Float32Array([0.25, -0.5])], 4), [0.5, 0.5, 1, 1], "短音频按时间位置复用样本");
assert.deepEqual(getWaveformPeaks([new Float32Array([0, 0, 0, 0, 1])], 2), [0, 1], "非整除尾部峰值必须保留");
assert.deepEqual(getWaveformPeaks([new Float32Array([0.25, -0.5]), new Float32Array([-0.25, 0.5])], 2), [0.5, 1], "左右反相不能互相抵消");
assert.deepEqual(getWaveformPeaks([new Float32Array(3), new Float32Array([0, 0.5, -1])], 3), [0, 0.5, 1], "右声道峰值参与全局归一化");
assert.deepEqual(getWaveformPeaks([new Float32Array([0.5]), new Float32Array([0, 0, 1])], 3), [0.5, 0, 1], "不等长声道包含最长声道尾部");
assert.deepEqual(getWaveformPeaks([new Float32Array([NaN, Infinity, -0.5])], 3), [0, 0, 1], "非有限采样不能污染整段波形");
for (const count of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => getWaveformPeaks([], count), RangeError);
console.log("audioWaveform OK: 静音、短采样、尾部峰值、左右反相、右声道和全局归一化");
