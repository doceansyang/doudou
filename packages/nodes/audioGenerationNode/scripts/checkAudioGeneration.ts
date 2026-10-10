// 运行：bun packages/nodes/audioGenerationNode/scripts/checkAudioGeneration.ts；执行真实组件逻辑，仅替换 AI 和文件桥接，真实请求 0。
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../nodeScaffold/package.json", import.meta.url));
const vue = await import(require.resolve("vue"));
const { compileScript, compileTemplate, parse } = await import(require.resolve("vue/compiler-sfc"));
const { readFile } = await import(require.resolve("@toonflow/file"));
const { z } = await import(require.resolve("zod"));
const { getTargetValues } = await import(require.resolve("@toonflow/nodes-scaffold/nodeInputs"));
const { isTypeCompatible } = await import(require.resolve("@toonflow/nodes-scaffold/connection"));
const audioSettings = await import("../src/audioSettings");
const tools = new Map<string, any>();
const events = new Map<string, (...args: any[]) => unknown>();
const calls: { input: Record<string, any>; signal: AbortSignal }[] = [];
const errors: unknown[] = [];
const fileActions: string[] = [];
const node = vue.reactive({ selected: true, data: { prompt: "音频草稿", promptModel: [[{ type: "Write", text: "音频草稿" }]], model: "" } });
const outputs = vue.ref<Record<string, any>>({});
const references = vue.ref<any[]>([]);
let availableModels = [
  { providerId: "mock", modelId: "image", type: "image", modelName: "图片" },
  { providerId: "mock", modelId: "audio", type: "audio", modelName: "音频" },
  { providerId: "mock", modelId: "video", type: "video", modelName: "视频" },
];
let generate = async (_input: Record<string, any>, _signal: AbortSignal): Promise<any[]> => [{ path: "assets/check/result.wav", mimeType: "audio/wav" }];
let upload = async () => "assets/check/upload.wav";
let uploadCalls = 0;
let pending: Promise<unknown> = Promise.resolve();
const nodeTools = { register(tool: any) { tools.set(tool.name, tool); } };
const generationSource = await readFile(new URL("../../../nodeScaffold/src/useNodeGeneration.ts", import.meta.url), "utf8");
const generationJavascript = new Bun.Transpiler({ loader: "ts" }).transformSync(generationSource.replace(/^import[^\n]*\n/gm, "").replace("export function useNodeGeneration", "function useNodeGeneration") + "\nreturn useNodeGeneration;");
const useNodeGeneration = new Function("computed", "ref", "nodeTools", "z", generationJavascript)(vue.computed, vue.ref, nodeTools, z);
const filename = new URL("../src/index.vue", import.meta.url);
const { descriptor } = parse(await readFile(filename, "utf8"), { filename: filename.pathname });
const script = compileScript(descriptor, { id: "audioGeneration" });
const bindings: Record<string, any> = Object.fromEntries(Object.entries(script.imports ?? {}).filter(([, item]) => !item.isType).map(([name]) => [name, { name }]));
Object.assign(bindings, Object.fromEntries(Object.entries(vue).filter(([name]) => name !== "default")), {
  _defineComponent: vue.defineComponent,
  onMounted() {},
  ElLoading: { directive: {} },
  z,
  getTargetValues,
  isTypeCompatible,
  nodeTools,
  showNodeError(error: unknown) { errors.push(error); },
  groupNodeModels(items: any[]) { return [{ id: "mock", label: "Mock", models: items }]; },
  useNode() {
    return { id: "check", node, nodeProps: vue.computed(() => ({})), outputs,
      nodeEvent: { on(name: string, callback: (...args: any[]) => unknown) { events.set(name, callback); } }, updateNodeInternals() {},
      files: { useFileUrl: (file: any) => vue.computed(() => file.value?.url ?? ""),
        getWorkspaceFiles: () => ({ list: async () => ({ directory: "memory" }), remove: async (path: string) => fileActions.push(`remove:${path}`) }),
        removeNodeFiles: async () => { fileActions.push("removeNodeFiles"); }, uploadFile: async () => { uploadCalls++; return upload(); } },
      ai: { getMediaModels: async () => availableModels, async generateAudio(input: Record<string, any>, signal: AbortSignal) {
        calls.push({ input, signal }); return generate(input, signal);
      } } };
  },
  useNodeReferences() { return { refList: references, referenceMentions: vue.ref([]), setReferencePreview() {}, removeReference() {} }; },
  useNodeGeneration(...args: any[]) {
    const generation = useNodeGeneration(...args);
    return { ...generation, run(action: () => Promise<unknown>) { return pending = generation.run(action); } };
  },
}, audioSettings);
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(script.content.replace(/^import[^\n]*\n/gm, "").replace("export default", "return"));
const component = new Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
const scope = vue.effectScope();
const setup = scope.run(() => component.setup({}, { expose() {} }));
const state = vue.proxyRefs(setup);
const template = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: "audioGeneration", compilerOptions: { bindingMetadata: script.bindings } });
assert.deepEqual(template.errors, []);
// ACT: 本地 renderer 不创建 DOM，加载遮罩只透传 VNode；界面样式由浏览器检查。
const render = new Function("vue", template.code.replace(/^import \{([^}]+)\} from "vue"\n/, (_match, names) => `const {${names.replaceAll(" as ", ": ")}} = vue;\n`).replace("export function render", "return function render"))({ ...vue, withDirectives: (value: unknown) => value });

async function execute(name: string, input: unknown = {}) {
  const tool = tools.get(name);
  assert.ok(tool, `缺少 ${name} 工具`);
  return tool.execute(await tool.parameters.parseAsync(input), {});
}

function findRendered(name: string, root = render({}, [], {}, state, {}, {}), imported = bindings) {
  const found: any[] = [];
  function visit(value: any) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.type === imported[name] || value.props?.class === name) found.push(value);
    if (Array.isArray(value.children)) visit(value.children);
    else if (value.children && typeof value.children === "object") {
      Object.values(value.children).filter(item => typeof item === "function").forEach((slot: any) => visit(slot()));
    }
  }
  visit(root);
  assert.ok(found.length, `未渲染 ${name}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const settingsFilename = new URL("../src/components/generationSettings.vue", import.meta.url);
const settingsDescriptor = parse(await readFile(settingsFilename, "utf8"), { filename: settingsFilename.pathname }).descriptor;
const settingsScript = compileScript(settingsDescriptor, { id: "audioSettings" });
const settingsBindings: Record<string, any> = Object.fromEntries(Object.entries(settingsScript.imports ?? {}).filter(([, item]) => !item.isType).map(([name]) => [name, { name }]));
Object.assign(settingsBindings, Object.fromEntries(Object.entries(vue).filter(([name]) => name !== "default")), audioSettings, { _defineComponent: vue.defineComponent, _useModel: vue.useModel, _mergeModels: vue.mergeModels });
const settingsJavascript = new Bun.Transpiler({ loader: "ts" }).transformSync(settingsScript.content.replace(/^import[^\n]*\n/gm, "").replace("export default", "return"));
const settingsComponent = new Function(...Object.keys(settingsBindings), settingsJavascript)(...Object.values(settingsBindings));
const settingsTemplate = compileTemplate({ source: settingsDescriptor.template!.content, filename: settingsFilename.pathname, id: "audioSettings", compilerOptions: { bindingMetadata: settingsScript.bindings } });
assert.deepEqual(settingsTemplate.errors, []);
const renderSettings = new Function("vue", settingsTemplate.code.replace(/^import \{([^}]+)\} from "vue"\n/, (_match, names) => `const {${names.replaceAll(" as ", ": ")}} = vue;\n`).replace("export function render", "return function render"))(vue);
let settingsState: Record<string, any>;
let settingsProps: Record<string, any>;
const originalSettingsSetup = settingsComponent.setup;
settingsComponent.setup = (props: any, context: any) => {
  settingsProps = props;
  settingsState = vue.proxyRefs(originalSettingsSetup(props, context));
  return () => null;
};
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
const settingsApp = renderer.createApp({ render: () => vue.h(settingsComponent, findRendered("generationSettings")[0].props) });
settingsApp.mount({});

async function selectSetting(value: string | number) {
  const controls = findRendered("ElSegmented", renderSettings({}, [], settingsProps!, settingsState!, {}, {}), settingsBindings);
  const control = controls.find(item => item.props.options.some((option: any) => option.value === value));
  assert.ok(control, `界面缺少选项 ${value}`);
  control.props["onUpdate:modelValue"](value);
  await vue.nextTick();
  const selected = findRendered("ElSegmented", renderSettings({}, [], settingsProps!, settingsState!, {}, {}), settingsBindings)
    .find(item => item.props.options.some((option: any) => option.value === value));
  assert.equal(selected.props.modelValue, value, "真实点选控件的受控值必须更新为选中选项");
}

try {
  await state.loadModels();
  assert.deepEqual(state.models.map((item: any) => item.type), ["audio"], "模型列表只保留媒体音频模型");
  assert.equal(state.data.model, '["mock","audio"]');
  assert.deepEqual(component.handles.map((item: any) => item.dataType), [["IMAGE", "AUDIO", "STRING"], "AUDIO"]);
  const config = await execute("getConfig");
  assert.deepEqual(config.config, { providerId: "mock", modelId: "audio", language: "zh-CN", sampleRate: 24000, format: "wav" });
  assert.deepEqual(config.languages.map((item: any) => item.value), ["zh-CN", "en"]);
  assert.deepEqual(config.sampleRates, [8000, 16000, 24000, 48000]);
  assert.deepEqual(config.formats, ["wav", "mp3", "pcm", "ogg_opus"]);
  assert.deepEqual(config.inputLimits, { text: "unlimited", imageOrAudio: 1 });
  state.data.model = '["mock","removed"]';
  await state.loadModels();
  assert.equal(state.data.model, '["mock","removed"]', "已配置模型失效不能静默换模型");
  await assert.rejects(execute("generateAudio"), /选择音频模型/);
  findRendered("modelSelect")[0].props["onUpdate:modelValue"]('["mock","audio"]');
  assert.equal(state.selectedModel.modelId, "audio");
  for (const language of ["zh-CN", "en"]) { await selectSetting(language); assert.equal(state.data.language, language); }
  for (const sampleRate of [8000, 16000, 24000, 48000]) { await selectSetting(sampleRate); assert.equal(state.data.sampleRate, sampleRate); }
  for (const format of ["wav", "mp3", "pcm", "ogg_opus"]) { await selectSetting(format); assert.equal(state.data.format, format); }
  for (const language of ["zh-CN", "en"]) await execute("setConfig", { language });
  for (const sampleRate of [8000, 16000, 24000, 48000]) await execute("setConfig", { sampleRate });
  for (const format of ["wav", "mp3", "pcm", "ogg_opus"]) await execute("setConfig", { format });
  for (const invalid of [{ providerId: "mock" }, { providerId: "mock", modelId: "image" }, { language: "cn" }, { sampleRate: 32000 }, { sampleRate: "24000" }, { format: "aac" }]) {
    await assert.rejects(execute("setConfig", invalid));
  }
  await execute("setConfig", { language: "zh-CN", sampleRate: 24000, format: "wav" });
  const prompt = findRendered("promptInput")[0].props;
  prompt["onUpdate:modelValue"]([[{ type: "Write", text: "界面提示词" }]]);
  prompt["onUpdate:text"]("界面提示词");
  assert.equal(state.data.prompt, "界面提示词");
  await execute("setPrompt", { prompt: "Agent 朗读\n第二行" });
  assert.deepEqual(JSON.parse(JSON.stringify(state.data.promptModel)), [[{ type: "Write", text: "Agent 朗读" }], [{ type: "Write", text: "第二行" }]]);

  function sourceNode(id: string, dataType: string | string[], value?: any) {
    return { id, data: { handles: [{ id: "out", type: "source", dataType }], outputs: value === undefined ? {} : { out: { dataType, value } } } };
  }
  const targetNode = { id: "check", data: { handles: component.handles } };
  const textSources = Array.from({ length: 100 }, (_, index) => sourceNode(`text${index}`, "STRING", index ? `文本 ${index + 1}` : " 保留文本参考 "));
  const picture = sourceNode("picture", "IMAGE", { url: "reference.png", mimeType: "image/png" });
  const audio = sourceNode("audio", "AUDIO", { url: "reference.wav", mimeType: "audio/wav" });
  const emptyPicture = sourceNode("emptyPicture", "IMAGE");
  const emptyAudio = sourceNode("emptyAudio", "AUDIO");
  const unknownMedia = sourceNode("unknownMedia", ["IMAGE", "AUDIO"]);
  const wildcard = sourceNode("wildcard", "*");
  const actualText = sourceNode("actualText", "STRING", "实际文本");
  actualText.data.handles[0]!.dataType = ["IMAGE", "AUDIO", "STRING"];
  const dual = { id: "dual", data: { handles: ["one", "two"].map(id => ({ id, type: "source", dataType: "IMAGE" })),
    outputs: { one: { dataType: "IMAGE", value: { url: "one.png", mimeType: "image/png" } }, two: { dataType: "IMAGE", value: { url: "two.png", mimeType: "image/png" } } } } };
  const nodes = [targetNode, ...textSources, picture, audio, emptyPicture, emptyAudio, unknownMedia, wildcard, actualText, dual];
  const connection = (source: string, sourceHandle = "out") => ({ source, sourceHandle, target: "check", targetHandle: "in" });
  const canConnect = events.get("canConnect");
  assert.ok(canConnect, "必须注册节点的 canConnect 限制");
  function checkConnection(candidate: ReturnType<typeof connection>, edges: ReturnType<typeof connection>[]) {
    return canConnect!(candidate, { nodes, edges, targetNode, sourceNode: nodes.find(item => item.id === candidate.source) });
  }
  const textEdges = textSources.map(item => connection(item.id));
  for (const [index, edge] of textEdges.entries()) assert.equal(checkConnection(edge, textEdges.slice(0, index)), true, "文本引用不能有数量限制");
  assert.equal(checkConnection(connection("picture"), textEdges), true);
  assert.equal(checkConnection(connection("audio"), textEdges), true);
  assert.equal(checkConnection(connection("picture"), [...textEdges, connection("picture")]), true, "已连接边重验不能把自身计算两次");
  assert.equal(checkConnection(connection("audio"), [...textEdges, connection("audio")]), true);
  assert.equal(checkConnection(connection("audio"), [...textEdges, connection("picture")]), false, "图片和音频互斥");
  assert.equal(checkConnection(connection("picture"), [...textEdges, connection("audio")]), false);
  assert.equal(checkConnection(connection("emptyPicture"), [...textEdges, connection("picture")]), false, "批次待提交图片边也占用额度");
  assert.equal(checkConnection(connection("emptyAudio"), [...textEdges, connection("audio")]), false);
  assert.equal(checkConnection(connection("emptyPicture"), textEdges), true);
  assert.equal(checkConnection(connection("emptyAudio"), [connection("emptyPicture")]), false, "未产出端口也必须按 handle 类型预留额度");
  assert.equal(checkConnection(connection("picture"), [connection("emptyAudio")]), false);
  assert.equal(checkConnection(connection("unknownMedia"), textEdges), true, "未知图片/音频类型按一条媒体边计数");
  assert.equal(checkConnection(connection("unknownMedia"), [connection("unknownMedia")]), true);
  assert.equal(checkConnection(connection("audio"), [connection("unknownMedia")]), false);
  assert.equal(checkConnection(connection("wildcard"), textEdges), true);
  assert.equal(checkConnection(connection("picture"), [connection("wildcard")]), false);
  assert.equal(checkConnection(connection("actualText"), [...textEdges, connection("picture")]), true, "已有输出按实际 STRING 类型计数");
  assert.equal(checkConnection(connection("dual", "two"), [connection("dual", "one")]), false, "同源节点不同输出口必须分别计数");
  assert.equal(getTargetValues("check", "in", nodes as any, [connection("dual", "one"), connection("dual", "two")]).length, 2);
  for (const edges of [[connection("picture"), connection("audio")], [connection("dual", "one"), connection("dual", "two")], [connection("audio"), connection("audio")]]) {
    references.value = getTargetValues("check", "in", nodes as any, edges);
    await assert.rejects(execute("generateAudio"), /图片|音频/);
    assert.equal(calls.length, 0, "绕过连线规则的旧引用数据必须在生成前拒绝");
  }
  references.value = getTargetValues("check", "in", nodes as any, [...textEdges, connection("picture")]);
  assert.deepEqual(await execute("generateAudio"), { status: "generating" });
  await pending;
  await state.generation;
  assert.match(calls[0]!.input.prompt, /^Agent 朗读\n第二行/);
  assert.match(calls[0]!.input.prompt, /参考 1：\n保留文本参考/);
  assert.match(calls[0]!.input.prompt, /参考 100：\n文本 100/);
  assert.deepEqual(calls[0]!.input.images, [{ path: "reference.png", mimeType: "image/png" }]);
  assert.deepEqual(calls[0]!.input.audios, []);
  assert.equal(calls[0]!.input.directory, "memory");
  assert.equal(calls[0]!.input.outputDirectory, "assets/check");
  assert.deepEqual([calls[0]!.input.language, calls[0]!.input.sampleRate, calls[0]!.input.format], ["zh-CN", 24000, "wav"]);
  assert.deepEqual(vue.toRaw(outputs.value.audio), { dataType: "AUDIO", value: { url: "assets/check/result.wav", mimeType: "audio/wav" } });
  assert.equal((await execute("getGenerationStatus")).status, "succeeded");
  assert.deepEqual(errors, []);
  references.value = getTargetValues("check", "in", nodes as any, [...textEdges, connection("audio")]);
  await execute("generateAudio");
  await pending;
  await state.generation;
  assert.deepEqual(calls[1]!.input.audios, [{ path: "reference.wav", mimeType: "audio/wav" }]);
  assert.deepEqual(calls[1]!.input.images, []);
  assert.match(calls[1]!.input.prompt, /参考 100：\n文本 100/);

  const previousOutput = structuredClone(vue.toRaw(outputs.value.audio));
  const slow = deferred<any[]>();
  generate = () => slow.promise;
  await execute("generateAudio");
  await vue.nextTick();
  await assert.rejects(execute("generateAudio"), /正在处理/);
  await assert.rejects(execute("setConfig", { format: "mp3" }), /正在处理/);
  assert.equal(findRendered("modelSelect")[0].props.disabled, true);
  assert.equal(findRendered("generationSettings")[0].props.disabled, true);
  assert.ok(findRendered("ElSegmented", renderSettings({}, [], settingsProps!, settingsState!, {}, {}), settingsBindings).every(item => item.props.disabled), "生成中三组点选控件必须都禁用");
  assert.equal(findRendered("sendButton")[0].props.title, "停止生成");
  findRendered("sendButton")[0].props.onClick();
  assert.equal(calls.at(-1)!.signal.aborted, true, "停止按钮必须取消当前请求");
  slow.resolve([{ path: "late.wav", mimeType: "audio/wav" }]);
  await assert.rejects(pending, { name: "AbortError" });
  await state.generation;
  assert.deepEqual(vue.toRaw(outputs.value.audio), previousOutput, "供应商忽略取消后晚返回不能覆盖旧输出");
  assert.equal((await execute("getGenerationStatus")).error, "生成已取消");
  generate = async () => { throw new Error("本地供应商失败"); };
  await execute("generateAudio");
  await assert.rejects(pending, /本地供应商失败/);
  await state.generation;
  assert.deepEqual(vue.toRaw(outputs.value.audio), previousOutput, "生成失败不能清空原输出");
  assert.equal((await execute("getGenerationStatus")).status, "failed");
  generate = async () => [];
  await execute("generateAudio");
  await assert.rejects(pending, /未返回音频/);
  await state.generation;
  assert.deepEqual(vue.toRaw(outputs.value.audio), previousOutput);
  state.actions = { processing: true, async cancelAndWait() { fileActions.push("cancelAndWait"); } };
  const requestCount = calls.length;
  await assert.rejects(execute("generateAudio"), /正在处理/);
  await assert.rejects(execute("setConfig", { language: "en" }), /正在处理/);
  assert.equal(calls.length, requestCount, "处理期间不能发起生成请求");
  assert.equal(findRendered("sendButton")[0].props.disabled, true);
  assert.throws(() => events.get("save")!("reload"), /音频处理中/);

  state.actions.processing = false;
  const deletingGeneration = deferred<any[]>();
  const cancellingProcessing = deferred<void>();
  generate = () => deletingGeneration.promise;
  state.actions.cancelAndWait = async () => { fileActions.push("cancelAndWait"); await cancellingProcessing.promise; };
  await execute("generateAudio");
  const deletion = events.get("delete")!();
  assert.equal(calls.at(-1)!.signal.aborted, true, "删除必须取消生成");
  assert.deepEqual(fileActions, ["cancelAndWait"]);
  deletingGeneration.resolve([{ path: "deleted.wav", mimeType: "audio/wav" }]);
  await assert.rejects(pending, { name: "AbortError" });
  await state.generation;
  assert.deepEqual(fileActions, ["cancelAndWait"], "仍有音频处理时不能先删除文件");
  cancellingProcessing.resolve();
  await deletion;
  assert.deepEqual(fileActions, ["cancelAndWait", "removeNodeFiles"]);
  assert.deepEqual(vue.toRaw(outputs.value.audio), previousOutput);

  const errorsBeforeUpload = errors.length;
  for (const file of [{ type: "image/png", size: 100 }, { type: "audio/wav", size: 0 }, { type: "audio/wav", size: 100 * 1024 * 1024 + 1 }]) {
    const input = { value: "chosen", files: [file] };
    await state.replaceOutput({ target: input });
    assert.equal(input.value, "", "替换后清空 input，允许重选同一文件");
    assert.equal(uploadCalls, 0, "非音频、空文件和超过 100 MB 必须在上传前拒绝");
    assert.deepEqual(vue.toRaw(outputs.value.audio), previousOutput);
  }
  assert.equal(errors.length, errorsBeforeUpload + 3);
  await state.replaceOutput({ target: { value: "chosen", files: [{ type: "audio/wav", size: 100 * 1024 * 1024 }] } });
  assert.equal(uploadCalls, 1, "恰好 100 MB 的音频应允许替换");
  assert.deepEqual(vue.toRaw(outputs.value.audio), { dataType: "AUDIO", value: { url: "assets/check/upload.wav", mimeType: "audio/wav" } });
  const uploadedOutput = structuredClone(vue.toRaw(outputs.value.audio));
  const lateUpload = deferred<string>();
  upload = () => lateUpload.promise;
  const replacing = state.replaceOutput({ target: { value: "chosen", files: [{ type: "audio/wav", size: 100 }] } });
  assert.equal(state.uploading, true);
  await assert.rejects(Promise.resolve(events.get("delete")!()), /正在替换/);
  assert.deepEqual(fileActions, ["cancelAndWait", "removeNodeFiles"], "上传期间不能删除节点文件");
  scope.stop();
  lateUpload.resolve("assets/check/disposed.wav");
  await replacing;
  assert.equal(state.uploading, false);
  assert.deepEqual(vue.toRaw(outputs.value.audio), uploadedOutput, "卸载后的迟到上传不能回写输出");
  assert.deepEqual(fileActions, ["cancelAndWait", "removeNodeFiles", "remove:assets/check/disposed.wav"], "卸载后的新上传文件必须清理");
  console.log("audioGeneration OK: 音频模型过滤、真实 UI/Agent 参数绑定、100 条文本及图片/音频合计 1 条的连线与生成校验、图片/音频请求与 AUDIO 输出、并发和取消保护、删除等待、上传边界与卸载清理；真实 AI 请求 0");
} finally { settingsApp.unmount(); scope.stop(); }
