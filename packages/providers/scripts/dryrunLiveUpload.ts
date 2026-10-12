// 真实链路探针：**真的**把本地素材上传到 toapis（上传免费），但**拦下** linke 的生成请求
// （只打印请求体、不真的提交，所以不花钱），用来确认「上传是否成功」与「生成请求体长什么样」。
//
// 运行：
//   LINKE_KEY=... UPLOAD_KEY=... bun run packages/providers/scripts/dryrunLiveUpload.ts
/// <reference path="../types.d.ts" />
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { mkdtemp, readFile } = await import(require.resolve("@toonflow/file"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toonflowLiveUpload"));
process.env.TOONFLOW_DATA_DIR = temporaryDirectory;

const realFetch = globalThis.fetch;

/** 造一张 32×32 的纯色 PNG（够小，上传快）。 */
function tinyPng(): Uint8Array {
  const w = 32, h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) raw.writeUInt8(200, rowStart + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(require("node:zlib").crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", require("node:zlib").deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

const { loadMediaProviderSource } = await import("../../../apps/server/src/utils/media/provider");
const source = await readFile(new URL("../src/media/JinyuDream.ts", import.meta.url), "utf8");

const uploaded: { status: number; body: string }[] = [];
const spy = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/v1/uploads/")) {
    const response = await realFetch(input, init);
    const text = await response.clone().text();
    uploaded.push({ status: response.status, body: text });
    console.log("[真实上传] " + url + "  → HTTP " + response.status);
    console.log("  " + text.slice(0, 240));
    return response;
  }
  console.log("\n[生成请求 · 已拦下未发出] " + String(init?.method ?? "GET") + " " + url);
  const body = typeof init?.body === "string" ? init.body : "<binary>";
  console.log("  " + body.slice(0, 1200));
  return Response.json({ task_id: "task_spy", status: "queued" });
}) as typeof fetch;
Object.assign(spy, { preconnect: realFetch.preconnect });

const provider = await loadMediaProviderSource(
  source,
  { apiKey: process.env.LINKE_KEY ?? "", uploadApiKey: process.env.UPLOAD_KEY ?? "" },
  undefined,
  spy,
);

const png = tinyPng();
console.log("本地素材大小:", png.byteLength, "bytes");

for (const [label, model] of [["wan3.0", "wan3.0-video"], ["seedance", "seedance-2-mini"], ["gpt-image", "gpt-image-2"]] as const) {
  console.log("\n================ " + label + " ================");
  try {
    if (label === "gpt-image") {
      await provider.generateImage!({
        model, prompt: "保持参考图内容不变", size: "1K", ratio: "1:1",
        images: [{ type: "binary", data: png, mimeType: "image/png" }],
      });
    } else {
      await provider.generateVideo!({
        model, prompt: "保持参考图内容不变", duration: label === "wan3.0" ? 2 : 4, resolution: "480p",
        ratio: "16:9",
        images: [{ type: "binary", data: png, mimeType: "image/png" }],
      });
    }
  } catch (error) {
    console.log("  ✗ " + (error instanceof Error ? error.message : String(error)));
  }
}

console.log("\n真实上传次数:", uploaded.length);
