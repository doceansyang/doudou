// 运行：bun packages/nodes/imageGenerationNode/scripts/checkPromptIsolation.ts；仅执行真实组件绑定和本地生成替身。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const require = createRequire(import.meta.resolve("@toonflow/nodes-scaffold"));
const { readFile } = await import(require.resolve("@toonflow/file"));
const { z } = await import(require.resolve("zod"));
const filename = new URL("../src/index.vue", import.meta.url);
const source = await readFile(filename, "utf8");
const { descriptor } = parse(source, { filename: filename.pathname });
const script = compileScript(descriptor, { id: "promptIsolation" });
const tools = new Map<string, { execute(args: unknown, context?: unknown): unknown }>();
const calls: { mode: string; input: Record<string, any> }[] = [];
const errors: unknown[] = [];
const node = vue.reactive({ data: { prompt: "普通草稿", promptModel: [[{ type: "Write", text: "普通草稿" }]], model: '["mock","image"]' } });
const references = vue.ref([
  { dataType: "STRING", value: "保留文字参考" },
  { dataType: "IMAGE", value: { url: "reference.png", mimeType: "image/png" } },
]);
const generating = vue.ref(false);
let pending: Promise<unknown> = Promise.resolve();
const bindings: Record<string, any> = Object.fromEntries(Object.entries(script.imports ?? {}).filter(([, item]) => !item.isType).map(([name]) => [name, { name }]));
Object.assign(bindings, vue, {
  _defineComponent: vue.defineComponent,
  onMounted() {},
  ElLoading: { directive: {} },
  z,
  nodeTools: { register(tool: any) { tools.set(tool.name, tool); } },
  showNodeError(error: unknown) { errors.push(error); },
  groupNodeModels() { return []; },
  useNode() {
    return { id: "check", node, nodeProps: vue.computed(() => ({})), outputs: vue.ref({}), nodeEvent: { on() {} }, updateNodeInternals() {},
      files: { useFileUrl: () => vue.ref("local-preview"), getWorkspaceFiles: () => ({ list: async () => ({ directory: "memory" }) }) },
      ai: { async generateImage(input: Record<string, any>) { calls.push({ mode: "normal", input }); return [{ path: "normal.png", mimeType: "image/png" }]; } } };
  },
  useNodeReferences() { return { refList: references, referenceMentions: vue.ref([]), setReferencePreview() {}, removeReference() {} }; },
  useNodeGeneration() {
    return { generating, run(action: () => Promise<unknown>) { generating.value = true; return pending = action().finally(() => { generating.value = false; }); } };
  },
});
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(script.content.replace(/^import[^\n]*\n/gm, "").replace("export default", "return"));
const component = new Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
const scope = vue.effectScope();
const setup = scope.run(() => component.setup({}, { expose() {} }));
const state = vue.proxyRefs(setup);
const template = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: "promptIsolation", compilerOptions: { bindingMetadata: script.bindings } });
assert.deepEqual(template.errors, []);
const render = new Function("vue", template.code.replace(/^import \{([^}]+)\} from "vue"\n/, (_match, names) => `const {${names.replaceAll(" as ", ": ")}} = vue;\n`).replace("export function render", "return function render"))(vue);
function promptProps() {
  const root = render({}, [], {}, state, {}, {});
  const skeleton = root.children.find((child: any) => child.type === bindings.nodeSkeleton);
  const card = skeleton.children.bottom()[0];
  return card.children.default().find((child: any) => child.type === bindings.promptInput).props;
}
function writePrompt(text: string) {
  const props = promptProps();
  props["onUpdate:modelValue"]([[{ type: "Write", text }]]);
  props["onUpdate:text"](text);
}

try {
  setup.models.value = [{ providerId: "mock", modelId: "image", type: "image", imageSizes: ["2K"], imageRatios: ["16:9"] }];
  assert.equal(state.data.inpaintPrompt, "");
  writePrompt("普通界面草稿");
  const normalInput = promptProps();
  setup.editor.value = { mode: "inpaint", busy: false,
    async generate(input: Record<string, any>) { calls.push({ mode: "inpaint", input }); return { url: "inpaint.png", mimeType: "image/png" }; },
    cancel() { setup.editor.value.mode = undefined; },
  };
  assert.equal(promptProps().text, "", "进入重绘不能带入普通提示词");
  writePrompt("只修改天空 {{ref 2}}");
  assert.equal(state.data.prompt, "普通界面草稿");
  assert.equal(state.data.promptModel[0][0].text, "普通界面草稿");
  normalInput["onUpdate:text"]("迟到的普通输入");
  assert.equal(promptProps().text, "只修改天空 {{ref 2}}", "旧输入框的延迟回写不能串入重绘草稿");
  tools.get("setPrompt")!.execute({ prompt: "Agent 普通提示词" });
  assert.equal(promptProps().text, "只修改天空 {{ref 2}}", "setPrompt 不能覆盖正在编辑的重绘提示词");
  await assert.rejects(Promise.resolve(tools.get("generateImage")!.execute({}, {})), /先退出局部重绘/);
  assert.equal(calls.length, 0, "普通生成工具不能隐式启动重绘");
  await state.startGeneration(true);
  await pending;
  assert.equal(calls[0]?.mode, "inpaint");
  assert.match(calls[0]!.input.prompt, /^只修改天空 \{\{ref 2\}\}/);
  assert.match(calls[0]!.input.prompt, /保留文字参考/);
  assert.match(calls[0]!.input.prompt, /参考 2.*对应第 3 张图/);
  assert.equal(calls[0]!.input.images[0].path, "reference.png");
  assert.equal(promptProps().text, "Agent 普通提示词", "退出重绘必须恢复普通草稿");
  await tools.get("generateImage")!.execute({}, {});
  await pending;
  assert.equal(calls[1]?.mode, "normal");
  assert.match(calls[1]!.input.prompt, /^Agent 普通提示词/);
  assert.doesNotMatch(calls[1]!.input.prompt, /只修改天空/);
  setup.editor.value.mode = "inpaint";
  assert.equal(promptProps().text, "只修改天空 {{ref 2}}", "重新进入重绘须保留独立草稿");
  assert.equal(state.data.inpaintPromptModel[0][0].text, "只修改天空 {{ref 2}}");
  assert.deepEqual(errors, []);
  console.log("promptIsolation OK: 普通/重绘富文本独立、切换保留、Agent 工具隔离、模型和参考保留；真实 AI 请求 0");
} finally { scope.stop(); }
