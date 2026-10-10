// 运行：bun packages/i18n/scripts/checkHostMessages.ts
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile, readdir } from "@toonflow/file";
import { IntlMessageFormat } from "intl-messageformat";
import { computed } from "vue";
import { msg, setLocale, translate } from "../src/vue";
import { i18nPlugin } from "../src/vite";
import { collectMessages } from "../src/transform";

const root = resolve(import.meta.dirname, "../../..");
const directory = resolve(root, "packages/i18n/src/locales");
const chinese: Record<string, string> = JSON.parse(await readFile(resolve(directory, "zhCn.json"), "utf8"));

function argumentsOf(message: string, language: string) {
  const format = new IntlMessageFormat(message, language, undefined, { ignoreTag: true });
  const argumentsFound = new Set<string>();
  function visit(nodes: ReturnType<IntlMessageFormat["getAst"]>) {
    for (const node of nodes) {
      if (node.type === 1 || node.type === 2 || node.type === 3 || node.type === 4 || node.type === 5 || node.type === 6) argumentsFound.add(node.value);
      if (node.type === 5 || node.type === 6) for (const option of Object.values(node.options)) visit(option.value);
      if (node.type === 8) visit(node.children);
    }
  }
  visit(format.getAst());
  return { names: [...argumentsFound].sort(), format };
}

const localeFiles = (await readdir(directory)).filter(file => file.endsWith(".json"));
assert.equal(localeFiles.length, 21);
for (const file of localeFiles) {
  const catalog: Record<string, string> = JSON.parse(await readFile(resolve(directory, file), "utf8"));
  const language = file === "zhCn.json" ? "zh-CN" : file === "zhTw.json" ? "zh-TW" : file.slice(0, -5);
  for (const key of Object.keys(chinese)) {
    assert.equal(typeof catalog[key], "string", `${file}: 缺少 ${key}`);
    assert(catalog[key]!.trim(), `${file}: 空译文 ${key}`);
    if (!/\{\d+\}/.test(key)) continue;
    const source = argumentsOf(key, "zh-CN");
    const target = argumentsOf(catalog[key]!, language);
    assert.deepEqual(target.names, source.names, `${file}: 参数不一致 ${key}`);
    target.format.format(Object.fromEntries(target.names.map(name => [name, 3])));
  }
}

for (const path of [
  "apps/web/src/pages/workspace/panels/document/components/workspaceSearch.vue",
  "apps/web/src/pages/workspace/panels/document/components/fileTree.vue",
  "apps/web/src/pages/workspace/panels/document/documentSession.ts",
  "apps/web/src/pages/workspace/panels/document/index.vue",
  "apps/web/src/components/settings/panels/pluginMarket/index.vue",
]) {
  for (const message of collectMessages(await readFile(resolve(root, path), "utf8"), path)) assert(Object.hasOwn(chinese, message), `${path}: 未抽取 ${message}`);
}

const status = msg`搜索完成。`;
const rendered = computed(() => translate(status));
setLocale("en");
assert.equal(rendered.value, "Search complete.");
setLocale("zh-CN");
assert.equal(rendered.value, "搜索完成。");
setLocale("ja");
assert.notEqual(rendered.value, "搜索完成。");
assert.notEqual(rendered.value, "Search complete.");
const fileName = "用户原稿.WAV {0}";
assert(translate(msg`关闭 ${fileName}`).includes(fileName));
setLocale("zh-CN");

const hook = i18nPlugin().transform;
const transform = typeof hook === "function" ? hook : hook?.handler;
assert(transform);
assert.equal(Reflect.apply(transform, {}, ["<template><p>插件文案保持原样</p></template>", "/repo/packages/ext/media/src/index.vue"]), undefined);
console.log(`HOST_I18N_CHECK_OK: ${localeFiles.length} 种语言，${Object.keys(chinese).length} 条宿主文案，参数、语言切换、用户内容与插件边界检查通过`);
