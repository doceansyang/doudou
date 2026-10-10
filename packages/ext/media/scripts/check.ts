// 运行：bun packages/ext/media/scripts/check.ts
import assert from "node:assert/strict";
import { pcmToWav, type PcmFormat } from "../src/pcmPreview";

async function samples(bytes: number[], format: PcmFormat) {
  const blob = pcmToWav(new Uint8Array(bytes).buffer, { sampleRate: 24000, channels: 1, format });
  assert.equal(blob.type, "audio/wav");
  const wave = new DataView(await blob.arrayBuffer());
  return Array.from({ length: wave.getUint32(40, true) / 2 }, (_, index) => wave.getInt16(44 + index * 2, true));
}

const input = new Uint8Array([0, 128, 255]);
const wave = new DataView(await pcmToWav(input.buffer, { sampleRate: 8000, channels: 1, format: "u8" }).arrayBuffer());
assert.equal(new TextDecoder().decode(new Uint8Array(wave.buffer, 0, 4)), "RIFF");
assert.equal(new TextDecoder().decode(new Uint8Array(wave.buffer, 8, 8)), "WAVEfmt ");
assert.equal(new TextDecoder().decode(new Uint8Array(wave.buffer, 36, 4)), "data");
assert.equal(wave.byteLength, 48);
assert.equal(wave.getUint32(4, true), 40);
assert.equal(wave.getUint32(16, true), 16);
assert.equal(wave.getUint16(20, true), 1);
assert.equal(wave.getUint16(22, true), 1);
assert.equal(wave.getUint32(24, true), 8000);
assert.equal(wave.getUint32(28, true), 8000);
assert.equal(wave.getUint16(32, true), 1);
assert.equal(wave.getUint16(34, true), 8);
assert.equal(wave.getUint32(40, true), 3);
assert.deepEqual([...new Uint8Array(wave.buffer, 44)], [0, 128, 255, 0]);
assert.deepEqual([...input], [0, 128, 255]);

assert.deepEqual(await samples([0, 128, 255, 255, 0, 0, 255, 127], "s16le"), [-32768, -1, 0, 32767]);
assert.deepEqual(await samples([128, 0, 255, 255, 0, 0, 127, 255], "s16be"), [-32768, -1, 0, 32767]);
assert.deepEqual(await samples([0, 0, 128, 255, 255, 255, 0, 0, 0, 255, 255, 127, 0, 0, 1], "s24le"), [-32768, -1, 0, 32767, 256]);
assert.deepEqual(await samples([128, 0, 0, 255, 255, 255, 0, 0, 0, 127, 255, 255, 1, 0, 0], "s24be"), [-32768, -1, 0, 32767, 256]);
assert.deepEqual(await samples([0, 0, 0, 128, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 127], "s32le"), [-32768, -1, 0, 32767]);
assert.deepEqual(await samples([128, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 127, 255, 255, 255], "s32be"), [-32768, -1, 0, 32767]);

for (const littleEndian of [true, false]) {
  const values = [-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -Infinity];
  const floats = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => floats.setFloat32(index * 4, value, littleEndian));
  assert.deepEqual(await samples([...new Uint8Array(floats.buffer)], littleEndian ? "f32le" : "f32be"), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0, 0]);
}

const stereo = new DataView(await pcmToWav(new Uint8Array([0, 128, 255, 127]).buffer, { sampleRate: 48000, channels: 2, format: "s16le" }).arrayBuffer());
assert.equal(stereo.getUint16(22, true), 2);
assert.equal(stereo.getUint32(28, true), 192000);
assert.equal(stereo.getUint16(32, true), 4);
assert.equal(stereo.getUint16(34, true), 16);
assert.equal(stereo.getUint32(4, true), 40);
assert.deepEqual([stereo.getInt16(44, true), stereo.getInt16(46, true)], [-32768, 32767]);

const options = { sampleRate: 24000, channels: 1, format: "s16le" as PcmFormat };
for (const sampleRate of [0, -1, 0.5, NaN, Infinity, 0x100000000, 0xffffffff]) {
  assert.throws(() => pcmToWav(new ArrayBuffer(2), { ...options, sampleRate }), RangeError);
}
for (const channels of [0, -1, 0.5, NaN, Infinity, 32768]) {
  assert.throws(() => pcmToWav(new ArrayBuffer(2), { ...options, channels }), RangeError);
}
for (const format of ["unknown", "toString", "__proto__", 1, null]) {
  assert.throws(() => pcmToWav(new ArrayBuffer(2), { ...options, format: format as PcmFormat }), RangeError);
}
assert.throws(() => pcmToWav(new ArrayBuffer(0), options), RangeError);
assert.throws(() => pcmToWav(new ArrayBuffer(1), options), RangeError);
assert.throws(() => pcmToWav(new ArrayBuffer(2), { ...options, channels: 2 }), RangeError);
assert.throws(() => pcmToWav(new ArrayBuffer(4), { ...options, format: "s24le" }), RangeError);
assert.throws(() => pcmToWav(new Uint8Array(2) as unknown as ArrayBuffer, options), RangeError);
console.log("PCM 转 WAV 检查通过");
