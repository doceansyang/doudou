<template>
  <div class="pluginMarket">
    <div class="marketToolbar">
      <nav class="marketNav" aria-label="插件列表">
        <button class="navButton" type="button" :aria-pressed="isMarketTab" @click="activeTab = 'discover'">发现插件</button>
        <button class="navButton" type="button" :aria-pressed="activeTab === 'installed'" @click="activeTab = 'installed'">已安装</button>
        <button class="navButton" type="button" :aria-pressed="activeTab === 'ffmpeg'" @click="activeTab = 'ffmpeg'">FFmpeg</button>
      </nav>
      <div class="marketActions">
        <!--
          「网页版市场」「开发者文档」两个入口已**整体删除**（2026-10-13，用户口径）：
          它们只是"上哪儿找插件"用的，指向的是 **Toonflow 自己的**控制台与飞书文档 ——
          放在我们的界面里等于把 toonflow 字样递给用户。
          要进那个控制台我们自己用浏览器访问即可；插件安装不依赖这两个入口
          （点「安装」是由服务端拿市场**当场返回**的签名链去下，见 installMarketPlugin）。
          也没有"管理员/用户两套版本"这回事：链接签名只有 1 小时有效期，存清单必然失效，
          现查现装本来就是同一条链路，一套版本就够。
        -->
        <template v-if="activeTab === 'installed'">
          <el-button v-if="selectedType === 'ext' || selectedType === 'all'" size="small" :icon="IconSettings" @click="associationsVisible = true">默认打开方式</el-button>
          <el-button size="small" type="primary" :icon="IconUpload" :loading="installing" aria-label="安装本地插件" @click="pluginFileInput?.click()">
            安装插件
          </el-button>
          <input ref="pluginFileInput" type="file" :accept="agentMarketEnabled ? '.umd.js,.tool.js,.agent.zip,.zip,.md,.tar,.tar.gz,.tgz' : '.umd.js,.tool.js,.zip,.md,.tar,.tar.gz,.tgz'" hidden @change="installFile" />
          <template v-if="agentMarketEnabled && selectedType === 'agent'">
            <el-button size="small" :icon="IconLink" :disabled="loading || !canManageAgents" @click="agentConnectVisible = true">连接远程 Agent</el-button>
            <el-button size="small" :icon="IconSettings" :disabled="loading || !canManageAgents" @click="a2aSettingsVisible = true">A2A 服务</el-button>
          </template>
        </template>
      </div>
      <div v-if="activeTab !== 'ffmpeg'" class="typeFilters" role="group" aria-label="插件类型">
        <button class="filterButton" type="button" :aria-pressed="selectedType === 'all'" @click="selectedType = 'all'">
          全部
          <span v-if="activeTab === 'installed' && installedCounts.all !== undefined" class="filterCount">{{ installedCounts.all }}</span>
        </button>
        <button
          v-for="(category, type) in pluginTypes"
          :key="type"
          class="filterButton"
          type="button"
          :disabled="type === 'agent' && !agentMarketEnabled"
          :title="type === 'agent' && !agentMarketEnabled ? '测试阶段，暂未开放' : undefined"
          :aria-pressed="selectedType === type"
          @click="selectedType = type">
          {{ category.label }}
          <span v-if="activeTab === 'installed' && installedCounts[type] !== undefined" class="filterCount">{{ installedCounts[type] }}</span>
        </button>
        <div class="personalFilters" role="group" aria-label="我的插件">
          <button class="filterButton" type="button" :aria-pressed="selectedType === 'collection'" @click="selectedType = 'collection'">收藏</button>
          <button class="filterButton" type="button" :aria-pressed="selectedType === 'my'" @click="selectedType = 'my'">我的</button>
        </div>
      </div>
      <form v-if="activeTab !== 'ffmpeg'" class="marketSearch" role="search" @submit.prevent="applySearch">
        <el-input v-model="searchQuery" size="small" placeholder="搜索插件" aria-label="搜索插件" clearable @clear="applySearch" />
        <el-button size="small" type="primary" nativeType="submit">搜索</el-button>
      </form>
    </div>

    <ffmpeg v-if="activeTab === 'ffmpeg'" :visible />
    <template v-else>
      <template v-if="activeTab === 'installed'">
        <el-alert v-for="message in visibleLoadErrors" :key="message" class="loadError" :title="message" type="error" :closable="false" showIcon />
      </template>
      <el-alert v-if="marketError" class="loadError" :title="marketError" type="error" :closable="false" showIcon>
        <el-button size="small" @click="marketRefreshKey++">重试</el-button>
      </el-alert>

      <div
        class="pluginList"
        :aria-label="`${selectedType === 'collection' ? '收藏' : selectedType === 'my' ? '我的' : tabs[activeTab]}列表`"
        :aria-busy="activeTab === 'installed' ? loading : marketLoading">
        <el-card
          v-for="plugin in visiblePlugins"
          :key="plugin.key"
          class="pluginCard"
          :class="{ viewable: canViewPlugin(plugin) }"
          shadow="never"
          role="group"
          :aria-label="plugin.displayName"
          :aria-haspopup="canViewPlugin(plugin) ? 'dialog' : undefined"
          :tabindex="canViewPlugin(plugin) ? 0 : undefined"
          @click="openPlugin(plugin)"
          @keydown.enter.self.prevent="openPlugin(plugin)"
          @keydown.space.self.prevent="openPlugin(plugin)">
          <div class="pluginHeader">
            <div class="pluginHeading">
              <h3 class="pluginName">
                <component :is="pluginTypes[plugin.type].icon" :size="18" aria-hidden="true" />
                <span class="pluginTitle">{{ plugin.displayName }}</span>
                <a
                  v-if="plugin.github"
                  class="repoLink"
                  :href="plugin.github"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="`${plugin.displayName} 的 GitHub`"
                  title="GitHub"
                  @click.stop>
                  <icon-external-link :size="14" aria-hidden="true" />
                </a>
              </h3>
              <span class="pluginId" :title="displayIdentifier(plugin)">{{ displayIdentifier(plugin) }}</span>
            </div>
            <el-tag :type="pluginTypes[plugin.type].tagType" size="small">{{ pluginTypes[plugin.type].label }}</el-tag>
          </div>
          <p v-if="plugin.description" class="pluginDescription">{{ plugin.description }}</p>
          <el-text v-if="plugin.loadError" type="danger" size="small">{{ plugin.loadError }}</el-text>
          <div v-if="plugin.author || plugin.version" class="pluginMeta">
            <span v-if="plugin.author" class="pluginAuthor">{{ plugin.author }}</span>
            <span v-if="plugin.version" class="pluginVersion" type="info" size="small" effect="plain">v{{ plugin.version }}</span>
          </div>
          <div v-if="isMarketTab" class="pluginFooter" @click.stop>
            <el-text v-if="installLabel(plugin) === '已安装'" type="info" size="small">已安装</el-text>
            <el-popconfirm
              v-else-if="pluginTypes[plugin.type].path"
              :title="`${translate(installLabel(plugin))}${pluginTypes[plugin.type].label}“${plugin.displayName}”（${plugin.fileName}）？`"
              width="280"
              :confirmButtonText="translate(installLabel(plugin))"
              cancelButtonText="取消"
              @confirm="installMarketPlugin(plugin)">
              <template #reference>
                <el-button
                  size="small"
                  type="primary"
                  :loading="pendingPlugins.has(plugin.key)"
                  :disabled="loading || pendingPlugins.has(plugin.key)"
                  :aria-label="`${translate(installLabel(plugin))} ${plugin.displayName}`">
                  {{ translate(installLabel(plugin)) }}
                </el-button>
              </template>
            </el-popconfirm>
            <el-text v-else type="info" size="small">{{ plugin.type === 'agent' && !agentMarketEnabled ? '测试阶段，暂未开放' : '暂不支持安装' }}</el-text>
            <div class="pluginActions">
              <component
                :is="plugin.isCollected ? IconStarFilled : IconStar"
                class="collectionIcon"
                :size="18"
                role="button"
                tabindex="0"
                :aria-disabled="collectingPlugins.has(plugin.key)"
                :aria-pressed="plugin.isCollected === true"
                :aria-label="`${plugin.isCollected ? '取消收藏' : '添加收藏'} ${plugin.displayName}`"
                :title="plugin.isCollected ? '取消收藏' : '添加收藏'"
                @click="toggleCollection(plugin)"
                @keydown.enter.prevent="toggleCollection(plugin)"
                @keydown.space.prevent="toggleCollection(plugin)" />
            </div>
          </div>
          <div v-else-if="plugin.type === 'skill'" class="pluginFooter" @click.stop>
            <div class="pluginActions">
              <el-button
                size="small"
                :icon="IconShare"
                :loading="exportingPlugins.has(plugin.key)"
                :disabled="loading || pendingPlugins.has(plugin.key)"
                :aria-label="`导出分享 ${plugin.displayName}`"
                title="导出分享"
                @click="exportPlugin(plugin)" />
              <el-popconfirm
                v-if="plugin.author !== 'JinyuTV'"
                :title="`确定卸载“${plugin.displayName}”及其附属文件吗？`"
                width="280"
                confirmButtonText="卸载"
                cancelButtonText="取消"
                confirmButtonType="danger"
                hideIcon
                @confirm="updatePlugin(plugin, 'uninstall')">
                <template #reference>
                  <el-button
                    size="small"
                    :loading="pendingPlugins.has(plugin.key)"
                    :disabled="!canEditPlugin(plugin) || loading || pendingPlugins.has(plugin.key) || exportingPlugins.has(plugin.key)"
                    :aria-label="`卸载 ${plugin.displayName}`">
                    卸载
                  </el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>

          <div v-else class="pluginFooter" :class="{ pluginControls: plugin.author !== 'JinyuTV' || plugin.type === 'agent' || plugin.type === 'ext' }" @click.stop>
            <label v-if="plugin.author !== 'JinyuTV' || plugin.type === 'agent' || plugin.type === 'ext'" class="pluginToggle">
              <span>{{ plugin.enabled === false ? "已禁用" : "已启用" }}</span>
              <el-switch
                :modelValue="plugin.enabled !== false"
                size="small"
                :loading="pendingPlugins.has(plugin.key)"
                :disabled="!canEditPlugin(plugin) || loading || pendingPlugins.has(plugin.key)"
                :aria-label="`启用 ${plugin.displayName}`"
                @change="updatePlugin(plugin, 'setEnabled', $event === true)" />
            </label>
            <el-text v-else type="info" size="small">已安装</el-text>
            <div class="pluginActions">
              <el-button
                v-if="plugin.type === 'node' || plugin.type === 'tool' || plugin.type === 'ext' || (plugin.type === 'agent' && plugin.kind === 'local')"
                size="small"
                :icon="IconShare"
                :loading="exportingPlugins.has(plugin.key)"
                :disabled="loading || pendingPlugins.has(plugin.key) || (plugin.type === 'tool' && !canManageTools) || (plugin.type === 'agent' && !canManageAgents) || (plugin.type === 'ext' && !plugin.canManage)"
                :aria-label="`导出分享 ${plugin.displayName}`"
                title="导出分享"
                @click="exportPlugin(plugin)" />
              <el-button v-if="plugin.type === 'agent' && plugin.kind === 'local'" size="small" :disabled="!canManageAgents || loading || pendingPlugins.has(plugin.key)" @click="selectedAgent = plugin">编辑</el-button>
              <el-button v-if="plugin.type === 'agent' && plugin.cardUrl" size="small" :icon="IconCopy" @click="copyCard(plugin.cardUrl)">Card</el-button>
              <el-badge v-if="(plugin.type === 'tool' || plugin.type === 'node' || plugin.type === 'ext') && plugin.configRules?.length" isDot :hidden="!hasMissingConfig(plugin)">
                <el-button
                  size="small"
                  :disabled="!canConfigurePlugin(plugin) || loading || pendingPlugins.has(plugin.key)"
                  :aria-label="`配置 ${plugin.displayName}${hasMissingConfig(plugin) ? '，有必填配置未填写' : ''}`"
                  @click="
                    selectedConfigPlugin = plugin;
                    configVisible = true;
                  ">
                  配置
                </el-button>
              </el-badge>
              <el-popconfirm
                v-if="plugin.author !== 'JinyuTV' || plugin.type === 'agent' || plugin.type === 'ext'"
                :title="`确定卸载“${plugin.displayName}”吗？`"
                width="240"
                confirmButtonText="卸载"
                cancelButtonText="取消"
                confirmButtonType="danger"
                hideIcon
                @confirm="updatePlugin(plugin, 'uninstall')">
                <template #reference>
                  <el-button
                    size="small"
                    :loading="pendingPlugins.has(plugin.key)"
                    :disabled="!canEditPlugin(plugin) || loading || pendingPlugins.has(plugin.key) || exportingPlugins.has(plugin.key)"
                    :aria-label="`卸载 ${plugin.displayName}`">
                    卸载
                  </el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </el-card>
      </div>
      <p v-if="activeTab === 'installed' ? loading : marketLoading" class="listStatus" role="status">正在加载插件…</p>
      <p v-else-if="!visiblePlugins.length && (isMarketTab ? !marketError : !visibleLoadErrors.length)" class="listStatus">
        {{ activeTab === "installed" ? "暂无符合条件的已安装插件" : selectedType === "collection" ? "暂无符合条件的收藏插件" : selectedType === "my" ? "暂无符合条件的已发布插件" : "未找到相关插件" }}
      </p>
      <el-pagination
        v-if="isMarketTab && !marketError"
        v-model:currentPage="marketPage"
        class="marketPagination"
        :pageSize="marketPageSize"
        :total="marketTotal"
        :disabled="marketLoading"
        :pagerCount="5"
        layout="total, prev, pager, next"
        size="small" />
      <pluginConfigDialog v-if="selectedConfigPlugin" v-model="configVisible" :plugin="selectedConfigPlugin" :canManage="canConfigurePlugin(selectedConfigPlugin)" />
      <extensionAssociationsDialog v-model="associationsVisible" />
      <agentEditorDialog v-if="selectedAgent" :key="selectedAgent.key" :agent="selectedAgent" :canManage="canManageAgents" @saved="refreshInstalled" @closed="selectedAgent = undefined" />
      <agentConnectDialog v-if="agentConnectVisible" @saved="refreshInstalled" @closed="agentConnectVisible = false" />
      <a2aSettingsDialog v-if="a2aSettingsVisible" @saved="refreshInstalled" @closed="a2aSettingsVisible = false" />
      <skillEditorDialog
        v-if="selectedSkill"
        :key="selectedSkill.key"
        :skill="selectedSkill"
        @saved="refreshInstalled"
        @closed="selectedSkill = undefined" />
      <el-dialog
        v-if="selectedPlugin"
        v-model="detailsVisible"
        :title="selectedPlugin.displayName"
        width="min(800px, calc(100vw - 32px))"
        alignCenter
        appendToBody
        destroyOnClose>
        <div class="pluginContent" tabindex="0" aria-label="插件说明">
          <messageMarkdown :content="brandify(selectedPlugin.readme ?? '')" />
        </div>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
import axios from "axios";
import parse from "semver/functions/parse";
import { computed, defineAsyncComponent, markRaw, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { IconBox, IconBook, IconTool, IconFileText, IconSparkles2, IconUpload, IconShare, IconStar, IconStarFilled, IconLink, IconSettings, IconCopy } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import tf from "@/lib/tf";
import { saveSettings } from "@/stores/settings";
import saveFile from "@/lib/saveFile";
import { writeClipboardText } from "@/lib/clipboard";
import pluginConfigDialog from "./pluginConfigDialog.vue";
import extensionAssociationsDialog from "./extensionAssociationsDialog.vue";
import skillEditorDialog from "./skillEditorDialog.vue";
import ffmpeg from "./ffmpeg.vue";
import agentEditorDialog from "./agentEditorDialog.vue";
import agentConnectDialog from "./agentConnectDialog.vue";
import a2aSettingsDialog from "./a2aSettingsDialog.vue";
import type { Plugin, PluginType } from "./types";
import { installPluginFile } from "../../installPluginFile";

const { visible = true } = defineProps<{ visible?: boolean }>();
const associationsVisible = ref(false);
// ACT: Agent 插件市场仍在测试，暂时关闭入口。
const agentMarketEnabled = false;
const pluginTypes = {
  node: { label: "节点", path: "nodes", icon: IconBox, tagType: "primary" },
  ext: { label: "文件扩展", path: "ext", icon: IconFileText, tagType: "info" },
  skill: { label: "技能", path: "skills", icon: IconBook, tagType: "success" },
  tool: { label: "工具", path: "tools", icon: IconTool, tagType: "warning" },
  agent: { label: "Agent", path: agentMarketEnabled ? "agents" : null, icon: IconSparkles2, tagType: "danger" },
} as const;
const tabs = { get discover() { return translate("发现插件"); }, get installed() { return translate("已安装"); }, ffmpeg: "FFmpeg" } as const;
const activeTab = ref<keyof typeof tabs>("discover");
const isMarketTab = computed(() => activeTab.value === "discover");
const marketPage = ref(1);
const marketPageSize = 20;
const marketTotal = ref(0);
const selectedTypes = ref<{ discover: PluginType | "all" | "collection" | "my"; installed: PluginType | "all" }>({ discover: "all", installed: "all" });
const selectedType = computed({
  get: () => selectedTypes.value[activeTab.value === "installed" ? "installed" : "discover"],
  set: (type: PluginType | "all" | "collection" | "my") => {
    if (activeTab.value === "ffmpeg") return;
    if (type === "collection" || type === "my") {
      activeTab.value = "discover";
      selectedTypes.value.discover = type;
    } else {
      if (selectedTypes.value[activeTab.value] === type) return;
      selectedTypes.value[activeTab.value] = type;
    }
    if (activeTab.value === "discover") marketPage.value = 1;
  },
});
const installedPlugins = ref<Plugin[]>([]);
const installedByKey = computed(() => new Map(installedPlugins.value.map((plugin) => [plugin.key, plugin])));
/**
 * 按「市场来源 identifier」再建一张表。市场的 identifier（`foodAestheticShortFilm`）与
 * 技能自报的名字（`food-aesthetic-short-film`）常常对不上，只认名字就会把装好的插件显示成「安装」。
 * NBSP 之类的不可见字符两边都要抹掉 —— 上游数据里真的混进了这种东西。
 */
function pluginKey(type: PluginType, identifier: string) {
  return `${type}:${identifier.replace(/[\s\u00a0\u3000]/g, "")}`;
}
const installedByOrigin = computed(() => {
  const map = new Map<string, Plugin>();
  for (const plugin of installedPlugins.value) {
    if (plugin.marketIdentifier) map.set(pluginKey(plugin.type, plugin.marketIdentifier), plugin);
  }
  return map;
});
const marketPlugins = ref<Plugin[]>([]);
const marketLoading = ref(false);
const marketError = ref("");
const marketRefreshKey = ref(0);
const loading = ref(false);
const loadErrors = ref<Partial<Record<PluginType, string>>>({});
const canManageTools = ref(false);
const canManageAgents = ref(false);
const selectedAgent = ref<Plugin>();
const agentConnectVisible = ref(false);
const a2aSettingsVisible = ref(false);
const pendingPlugins = ref(new Set<string>());
const collectingPlugins = ref(new Set<string>());
const exportingPlugins = ref(new Set<string>());
const pluginFileInput = ref<HTMLInputElement>();
const installing = ref(false);
const refreshKey = ref(0);
const refreshInstalled = () => {
  refreshKey.value++;
};
onMounted(() => window.addEventListener("toonflow:plugin-installed", refreshInstalled));
onBeforeUnmount(() => window.removeEventListener("toonflow:plugin-installed", refreshInstalled));
const selectedConfigPlugin = ref<Plugin>();
const configVisible = ref(false);
const selectedPlugin = ref<Plugin>();
const selectedSkill = ref<Plugin>();
const detailsVisible = ref(false);
const messageMarkdown = defineAsyncComponent(() => import("@/components/messageMarkdown.vue"));
const requestHeaders = { "x-toonflow-workspace": "1" };

const searchQuery = ref("");
const appliedQuery = ref("");
const installedCounts = computed(() => {
  const counts: Partial<Record<PluginType | "all", number>> = {};
  if (loading.value) return counts;
  if (!Object.keys(loadErrors.value).length) counts.all = installedPlugins.value.length;
  for (const type of Object.keys(pluginTypes) as PluginType[]) {
    if (!loadErrors.value[type]) counts[type] = installedPlugins.value.filter((plugin) => plugin.type === type).length;
  }
  return counts;
});
const visibleLoadErrors = computed(() =>
  Object.entries(loadErrors.value)
    .filter(([type]) => selectedType.value === "all" || type === selectedType.value)
    .map(([, message]) => message)
);
const visiblePlugins = computed(() => {
  if (isMarketTab.value) return marketPlugins.value;
  return installedPlugins.value.filter(
    (plugin) =>
      (selectedType.value === "all" || plugin.type === selectedType.value) &&
      [displayIdentifier(plugin), plugin.displayName, plugin.author, plugin.description].some((value) =>
        value?.toLowerCase().includes(appliedQuery.value.toLowerCase())
      )
  );
});

/**
 * 卡片上那行小字显示的是插件的 identifier。上游有几个插件把**自家品牌**写进了
 * identifier（如 `toonflowLuxuryPawnRecoveryComicDrama`），原样显示等于把来源
 * 暴露给终端用户 —— 这里**只在显示层**把 `toonflow` 前缀摘掉。
 *
 * ⚠️ 绝不能改 `plugin.name` 本身：安装 / 卸载 / 启停 / 导出 / 匹配已安装
 * （`installedByKey.get(\`${type}:${name}\`)`）全靠它精确匹配，改了会装不上、
 * 也认不出已装。所以只做"显示"这一件事，拿到的字符串不要回流进任何请求。
 */
function displayIdentifier(plugin: Plugin) {
  return plugin.name.replace(/^toonflow[-_ ]?/i, "").trim() || plugin.name;
}

/**
 * 显示层的品牌映射：把插件自带的 Toonflow 字样换成我们自己的。
 *
 * 这些字来自插件自己的元数据 —— 已安装列表里的 "Toonflow-Depth"、"面向 Toonflow 的…" 之类，
 * 源头是本地 skills 目录下的 SKILL.md 与节点脚本里的 displayName，不是我们的文案。
 * 文件躺在用户机器上，改文件又会被下次更新覆盖，所以只在显示层换。
 *
 * 只作用于 displayName / description / readme 这几个纯展示字段；
 * 不要碰 name / identifier / fileName —— 安装、卸载、匹配已安装全靠它们，改了会装不上。
 */
function brandify(text: string | undefined) {
  return typeof text === "string" ? text.replace(/toonflow/gi, "JinyuTV") : "";
}

function canViewPlugin(plugin: Plugin) {
  return activeTab.value === "installed" && (plugin.type === "skill" || (plugin.type === "agent" && plugin.kind === "local" && canManageAgents.value))
    ? !loading.value && !pendingPlugins.value.has(plugin.key)
    : !!plugin.readme?.trim();
}

function openPlugin(plugin: Plugin) {
  if (!canViewPlugin(plugin)) return;
  if (activeTab.value === "installed" && plugin.type === "agent" && plugin.kind === "local" && canManageAgents.value) {
    selectedAgent.value = plugin;
    return;
  }
  if (activeTab.value === "installed" && plugin.type === "skill") {
    selectedSkill.value = plugin;
    return;
  }
  selectedPlugin.value = plugin;
  detailsVisible.value = true;
}

function canConfigurePlugin(plugin: Plugin) {
  return plugin.type === "node" || plugin.type === "ext" ? plugin.canConfigure === true : plugin.type === "tool" && canManageTools.value;
}

function hasMissingConfig(plugin: Plugin) {
  if (!canConfigurePlugin(plugin)) return false;
  return (plugin.configRules ?? []).some((rule) => {
    const required = rule.required === true || (Array.isArray(rule.validate) && rule.validate.some((validation) =>
      validation && typeof validation === "object" && "required" in validation && validation.required === true));
    if (!required || typeof rule.field !== "string") return false;
    const config = plugin.config ?? {};
    const value = Object.hasOwn(config, rule.field) ? config[rule.field] : rule.value;
    return value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
  });
}

watch(activeTab, () => { marketPage.value = 1; });

watch(
  () => [visible, activeTab.value, selectedTypes.value.discover, marketPage.value, appliedQuery.value, marketRefreshKey.value],
  async (_value, _previous, onCleanup) => {
    if (!visible || !isMarketTab.value) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    marketLoading.value = true;
    marketError.value = "";
    marketPlugins.value = [];
    try {
      const pageData = await tf.getPlugIn(
        {
          page: marketPage.value,
          limit: marketPageSize,
          type: selectedTypes.value.discover,
          ...(appliedQuery.value ? { searchKeyword: appliedQuery.value } : {}),
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      if (
        !pageData ||
        !Number.isSafeInteger(pageData.total) ||
        pageData.total < 0 ||
        !Array.isArray(pageData.list) ||
        pageData.list.some(
          (item) =>
            !item ||
            !Number.isSafeInteger(item.id) ||
            !Object.hasOwn(pluginTypes, item.type) ||
            typeof item.identifier !== "string" ||
            !item.identifier.trim() ||
            typeof item.name !== "string" ||
            typeof item.link !== "string" ||
            !item.link.trim() ||
            typeof item.fileName !== "string" ||
            !item.fileName.trim()
        )
      )
        throw new Error("插件市场列表格式错误");
      marketTotal.value = pageData.total;
      const lastPage = Math.max(1, Math.ceil(pageData.total / marketPageSize));
      if (marketPage.value > lastPage) {
        marketPage.value = lastPage;
        return;
      }
      marketPlugins.value = pageData.list.map((item) => ({
        key: `market:${item.id}`,
        id: item.id,
        isCollected: item.isCollected,
        type: item.type as PluginType,
        name: item.identifier.trim(),
        displayName: brandify(item.name.trim() || item.identifier.trim()),
        author: brandify(typeof item.supplier === "string" ? item.supplier : ""),
        description: brandify(typeof item.desc === "string" ? item.desc : ""),
        url: item.link,
        fileName: item.fileName.trim(),
        version: item.version,
      }));
    } catch (error) {
      if (!controller.signal.aborted) {
        marketTotal.value = 0;
        // 凭据在服务端（中转持有），客户端这里不再区分"没填 key"和"登录失效" —— 一律当作暂时不可用。
        marketError.value = errorMessage(error, "加载插件市场失败，请重试");
      }
    } finally {
      if (!controller.signal.aborted) marketLoading.value = false;
    }
  },
  { immediate: true }
);
watch(
  () => [visible, activeTab.value, refreshKey.value],
  async (_value, _previous, onCleanup) => {
    if (!visible || activeTab.value === "ffmpeg") return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    loading.value = true;
    loadErrors.value = {};
    canManageTools.value = false;
    canManageAgents.value = false;
    installedPlugins.value = [];
    const results = await Promise.all(
      (Object.keys(pluginTypes) as PluginType[]).map(async (type) => {
        const category = pluginTypes[type];
        if (!category.path) return [];
        try {
          const { data } = await axios.get(`/api/${category.path}/${type === "ext" ? "list" : "get"}`, {
            signal: controller.signal,
            headers: { ...requestHeaders, "Cache-Control": "no-cache" },
          });
          const items = type === "tool" ? data.data?.tools : type === "agent" ? data.data?.agents : data.data;
          if (data.code !== 200 || !Array.isArray(items) || items.some((item) => !item || typeof item.name !== "string"))
            throw new Error(`${category.label}列表格式错误`);
          if (controller.signal.aborted) return [];
          if (type === "tool") canManageTools.value = data.data.canManage === true;
          if (type === "agent") canManageAgents.value = data.data.canManage === true;
          return items.map((item) => ({
            ...item,
            type,
            key: `${type}:${item.name}`,
            displayName: brandify(item.displayName || item.name),
            description: brandify(item.description),
            author: brandify(item.author),
            configRules: markRaw(item.configRules ?? []),
          } as Plugin));
        } catch (error) {
          if (!controller.signal.aborted) loadErrors.value[type] = errorMessage(error, `加载${category.label}失败，请重新打开列表重试`);
          return [];
        }
      })
    );
    if (controller.signal.aborted) return;
    installedPlugins.value = results.flat();
    loading.value = false;
  },
  { immediate: true }
);


function applySearch() {
  appliedQuery.value = searchQuery.value.trim();
  marketPage.value = 1;
}

function errorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) return typeof error.response?.data?.message === "string" ? error.response.data.message : fallback;
  return error instanceof Error ? error.message : fallback;
}

async function copyCard(url: string) {
  try {
    await writeClipboardText(url);
    ElMessage.success("Agent Card 地址已复制");
  } catch {
    await ElMessageBox.alert(url, "Agent Card 地址", { confirmButtonText: "关闭" }).catch(() => {});
  }
}

function canEditPlugin(plugin: Plugin) {
  return (
    activeTab.value === "installed" &&
    (plugin.author !== "JinyuTV" || plugin.type === "agent" || plugin.type === "ext") &&
    (plugin.type === "node" || plugin.type === "skill" || (plugin.type === "ext" && plugin.canManage === true) || (plugin.type === "tool" && canManageTools.value) || (plugin.type === "agent" && canManageAgents.value))
  );
}

function installLabel(plugin: Plugin) {
  // ⚠️ 别用 plugin.key —— 市场卡片的 key 是 `market:<id>`，这里是拿"名字/来源"去已安装表里取值。
  const lookup = pluginKey(plugin.type, plugin.name);
  // 先按名字精确认，认不到再按安装来源认 —— 市场 identifier 与技能真名不一致时靠后者兜住。
  const installed = installedByKey.value.get(lookup) ?? installedByOrigin.value.get(lookup);
  if (!installed) return "安装";
  const [current, incoming] = [installed.version, plugin.version].map(value => {
    const version = parse(value ?? "");
    if (!version || version.raw.trim().startsWith("v")
      || version.prerelease.some(part => /^\d+$/.test(String(part)) && !Number.isSafeInteger(Number(part)))) return null;
    return version;
  });
  return current && incoming && incoming.compare(current) > 0 ? "更新" : "已安装";
}

async function toggleCollection(plugin: Plugin) {
  if (plugin.id === undefined || collectingPlugins.value.has(plugin.key)) return;
  collectingPlugins.value.add(plugin.key);
  try {
    const { collected } = await tf.toggleCollection(plugin.id);
    const current = marketPlugins.value.find(item => item.id === plugin.id);
    if (current) current.isCollected = collected;
    if (selectedType.value === "collection" || marketLoading.value) marketRefreshKey.value++;
    ElMessage.success(collected ? "收藏成功" : "已取消收藏");
  } catch (error) {
    ElMessage.error(errorMessage(error, "修改收藏失败，请重试"));
  } finally {
    collectingPlugins.value.delete(plugin.key);
  }
}

async function installMarketPlugin(plugin: Plugin) {
  const path = pluginTypes[plugin.type].path;
  if (!path || !plugin.url || !plugin.fileName || loading.value || pendingPlugins.value.has(plugin.key)) return;
  const action = installLabel(plugin);
  if (action === "已安装") return;
  pendingPlugins.value.add(plugin.key);
  try {
    const { data } = await axios.post(`/api/${path}/install`, { url: plugin.url, fileName: plugin.fileName }, { headers: requestHeaders });
    if (data.code !== 200) throw new Error(data.message || "安装插件失败");
    window.dispatchEvent(new CustomEvent("toonflow:plugin-installed", { detail: { type: plugin.type, name: data.data.name } }));
    if (plugin.type === "ext") window.dispatchEvent(new CustomEvent("toonflow:ext-updated", { detail: { name: data.data.name } }));
    ElMessage.success(action === "更新" ? `${plugin.displayName}已更新` : `${plugin.displayName}已安装`);
  } catch (error) {
    ElMessage.error(errorMessage(error, "安装插件失败，请重试"));
  } finally {
    pendingPlugins.value.delete(plugin.key);
  }
}

async function installFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || installing.value) return;
  installing.value = true;
  try {
    const type = /\.agent\.zip$/i.test(file.name)
      ? "agent"
      : /^ext-[a-z][a-zA-Z0-9]*\.umd\.js$/.test(file.name)
      ? "ext"
      : /\.umd\.js$/i.test(file.name)
      ? "node"
      : /\.tool\.js$/i.test(file.name)
      ? "tool"
      : /\.(zip|md|tar|tar\.gz|tgz)$/i.test(file.name)
      ? "skill"
      : undefined;
    if (!type) throw new Error("请选择文件扩展 ext-*.umd.js、Agent .agent.zip、节点 .umd.js、工具 .tool.js 或技能 .zip、.md、.tar、.tar.gz、.tgz 文件");
    if (type === "agent" && !agentMarketEnabled) throw new Error("Agent 功能处于测试阶段，暂未开放安装");
    await installPluginFile(type, file);
    ElMessage.success(`${pluginTypes[type].label}已安装`);
  } catch (error) {
    ElMessage.error(errorMessage(error, "安装插件失败，请重试"));
  } finally {
    installing.value = false;
  }
}

async function exportPlugin(plugin: Plugin) {
  if (
    activeTab.value !== "installed" ||
    (plugin.type === "agent" && (plugin.kind !== "local" || !canManageAgents.value)) ||
    exportingPlugins.value.has(plugin.key) ||
    pendingPlugins.value.has(plugin.key) ||
    loading.value ||
    (plugin.type === "tool" && !canManageTools.value) ||
    (plugin.type === "ext" && !plugin.canManage)
  )
    return;
  exportingPlugins.value.add(plugin.key);
  try {
    const fileName = `${plugin.name}.${plugin.type === "node" || plugin.type === "ext" ? "umd.js" : plugin.type === "tool" ? "tool.js" : plugin.type === "agent" ? "agent.zip" : "zip"}`;
    await saveFile(
      () =>
        axios
          .get<Blob>("/api/plugins/export", { params: { type: plugin.type, name: plugin.name }, responseType: "blob", headers: requestHeaders })
          .then(({ data }) => data),
      fileName
    );
  } catch (error) {
    let message = errorMessage(error, "导出插件失败，请重试");
    if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
      const data = await error.response.data
        .text()
        .then(JSON.parse)
        .catch(() => null);
      if (typeof data?.message === "string") message = data.message;
    }
    ElMessage.error(message);
  } finally {
    exportingPlugins.value.delete(plugin.key);
  }
}

async function updatePlugin(plugin: Plugin, action: "setEnabled" | "uninstall", enabled?: boolean) {
  if (
    !canEditPlugin(plugin) ||
    loading.value ||
    pendingPlugins.value.has(plugin.key) ||
    exportingPlugins.value.has(plugin.key) ||
    (plugin.type === "skill" && action !== "uninstall")
  )
    return;
  pendingPlugins.value.add(plugin.key);
  const actionLabel = action === "uninstall" ? translate("卸载插件") : translate("更新插件状态");
  try {
    const url = `/api/${pluginTypes[plugin.type].path}/${action}`;
    const { data } =
      action === "uninstall"
        ? await axios.delete(url, { data: { name: plugin.name }, headers: requestHeaders })
        : await axios.put(url, { name: plugin.name, enabled }, { headers: requestHeaders });
    if (data.code !== 200) throw new Error(data.message || `${actionLabel}失败`);
    if (action === "uninstall") {
      installedPlugins.value = installedPlugins.value.filter((item) => item.key !== plugin.key);
      if (selectedSkill.value?.key === plugin.key) selectedSkill.value = undefined;
      if (selectedAgent.value?.key === plugin.key) selectedAgent.value = undefined;
      if (selectedConfigPlugin.value?.key === plugin.key) {
        configVisible.value = false;
        selectedConfigPlugin.value = undefined;
      }
      if (selectedPlugin.value?.key === plugin.key) {
        detailsVisible.value = false;
        selectedPlugin.value = undefined;
      }
      ElMessage.success("插件已卸载");
    } else plugin.enabled = enabled;
    if (plugin.type === "node")
      window.dispatchEvent(new CustomEvent("toonflow:plugin-installed", { detail: { type: plugin.type, name: plugin.name } }));
    if (plugin.type === "ext") window.dispatchEvent(new CustomEvent("toonflow:ext-updated", { detail: { name: plugin.name } }));
  } catch (error) {
    ElMessage.error(errorMessage(error, `${actionLabel}失败，请重试`));
  } finally {
    pendingPlugins.value.delete(plugin.key);
  }
}
</script>

<style lang="scss" scoped>
.pluginMarket {
  .marketKey {
    margin-bottom: 12px;

    :deep(.el-card__body) {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }

    .keyForm {
      display: flex;
      width: 100%;
      gap: 8px;
    }
  }

  .marketToolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 12px;
    background: var(--el-bg-color);

    .marketNav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 20px;

      .navButton {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 0 0 6px;
        border: 0;
        background: transparent;
        color: var(--el-text-color-secondary);
        font: inherit;
        cursor: pointer;

        &[aria-pressed="true"] {
          color: var(--el-text-color-primary);
          font-weight: 600;
          &::after {
            position: absolute;
            right: 0;
            bottom: 0;
            left: 0;
            height: 2px;
            border-radius: 2px;
            background: currentColor;
            content: "";
          }
        }
        &:hover {
          color: var(--el-text-color-primary);
        }
        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 3px;
        }
      }
    }

    .marketActions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 8px;
      margin-left: auto;

      .el-button { margin-left: 0; }
    }

    .typeFilters {
      display: flex;
      flex-basis: 100%;
      flex-wrap: wrap;
      gap: 6px;

      .personalFilters {
        display: flex;
        gap: 6px;
        margin-left: auto;
      }

      .filterButton {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        border: 0;
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-secondary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;

        .filterCount {
          padding: 1px 6px;
          border-radius: 6px;
          background: var(--el-fill-color);
          font-size: 11px;
          font-weight: 500;
        }

        &:hover:not(:disabled) {
          background: var(--el-fill-color-light);
        }
        &:disabled {
          color: var(--el-text-color-disabled);
          cursor: not-allowed;
        }
        &[aria-pressed="true"] {
          /* 同设置侧栏：主色近黑时「主色浅底 + 主色字」会变成黑块，改用主题中性色。 */
          background: var(--el-fill-color-dark);
          color: var(--el-text-color-primary);
        }
        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 2px;
        }
      }
    }

    .marketSearch {
      display: flex;
      flex-basis: 100%;
      min-width: 0;
      gap: 8px;
    }
  }

  .loadError {
    margin-bottom: 12px;
  }

  .pluginList {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
    gap: 10px;
    padding-bottom: 4px;

    .pluginCard {
      min-width: 0;

      &.viewable {
        cursor: pointer;

        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 2px;
        }
      }

      :deep(.el-card__body) {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 12px;
        box-sizing: border-box;
      }

      .pluginHeader {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;

        > .el-tag {
          flex-shrink: 0;
        }

        .pluginHeading {
          min-width: 0;

          .pluginName {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            margin: 0;
            font-size: 14px;
            font-weight: 600;
            overflow-wrap: anywhere;

            .pluginTitle {
              min-width: 0;
            }

            svg {
              flex-shrink: 0;
            }
            .repoLink {
              display: inline-flex;
              flex-shrink: 0;
              color: var(--el-text-color-secondary);
              &:hover {
                // 悬停变主色，主色近黑时这一下会「消失」。
                color: var(--ui-brand-foreground, var(--el-color-primary));
              }
              &:focus-visible {
                outline: 2px solid var(--ui-brand-foreground, var(--el-color-primary));
                outline-offset: 2px;
              }
            }
          }

          .pluginId {
            display: block;
            margin-top: 6px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
            line-height: 1.5;
            color: var(--el-text-color-placeholder);
          }
        }
      }

      .pluginMeta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px 12px;
        margin-top: 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--el-text-color-secondary);
        overflow-wrap: anywhere;

        .pluginAuthor {
          flex: 1;
          min-width: 0;
        }

        .pluginVersion {
          flex-shrink: 0;
          margin-left: auto;
        }
      }
      .pluginDescription {
        margin: 10px 0 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--el-text-color-regular);
        overflow-wrap: anywhere;
      }

      .pluginFooter {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: auto;
        padding-top: 12px;

        &.pluginControls {
          align-items: stretch;
          flex-direction: column;
          gap: 12px;

          &::before {
            border-top: 1px solid var(--el-border-color-lighter);
            content: "";
          }
        }

        .pluginToggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: var(--el-text-color-secondary);
          font-size: 12px;
          cursor: pointer;

          > .el-switch {
            flex-shrink: 0;
          }
        }
        .pluginActions {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 8px;
          max-width: 100%;
          min-width: 0;
          margin-left: auto;
          .el-button {
            margin-left: 0;
          }
          .collectionIcon {
            color: var(--el-text-color-secondary);
            cursor: pointer;

            &[aria-pressed="true"] {
              color: #f5c518;
            }
            &[aria-disabled="true"] {
              opacity: 0.5;
              cursor: wait;
            }
            &:focus-visible {
              outline: 2px solid currentColor;
              outline-offset: 3px;
            }
          }
        }
      }
    }
  }

  .marketPagination {
    justify-content: center;
    margin-top: 16px;
  }

  .listStatus {
    margin: 24px 0;
    color: var(--el-text-color-secondary);
    text-align: center;
  }
}

.pluginContent {
  max-height: min(65vh, calc(100dvh - 160px));
  overflow: auto;
  overflow-wrap: anywhere;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1.7;
}
</style>
