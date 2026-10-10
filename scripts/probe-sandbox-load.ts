/**
 * 复现 Toonflow 服务端加载供应商的方式（node:vm + SourceTextModule），
 * 用来判定「画布上调用这个供应商」是否可行。
 *
 * 与 apps/server/src/utils/media/provider.ts 的 loadMediaProviderSource 保持一致。
 */
import { createContext, SourceTextModule } from "node:vm";

const file = process.argv[2] ?? "data/providers/doubaoAccount.ts";
const source = await Bun.file(file).text();

const providerTranspiler = new Bun.Transpiler({ loader: "ts", target: "bun", define: { require: "undefined" } });
const transpiled = providerTranspiler.transformSync(source);
console.log(`转译完成：${source.length} → ${transpiled.length} 字符`);

const context = createContext(
  {
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
  },
  { codeGeneration: { strings: false, wasm: false } },
);

const rejectImport = () => {
  throw new Error("供应商不能导入模块，请使用 this.tool 中的宿主工具");
};

const module = new SourceTextModule(transpiled, {
  context,
  identifier: "doubaoAccount.ts",
  importModuleDynamically: rejectImport,
});

try {
  await module.link(rejectImport);
  console.log("link 阶段：✓ 通过");
} catch (error) {
  console.log("link 阶段：✗ 失败 →", (error as Error).message);
  process.exit(0);
}

try {
  await module.evaluate({ timeout: 1000 });
  const definition = (module.namespace as { default?: { id?: string } }).default;
  console.log("evaluate 阶段：✓ 通过，供应商 id =", definition?.id);
} catch (error) {
  console.log("evaluate 阶段：✗ 失败 →", (error as Error).message);
}
