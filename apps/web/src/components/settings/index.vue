<template>
  <el-dialog v-model="visible" title="设置" width="min(1080px, calc(100vw - 32px))" alignCenter appendToBody>
    <div class="settings" @click.capture="onSettingsClick">
      <aside class="sidebar" aria-label="设置分类">
        <template v-for="item in settingsPanels" :key="item.id">
          <h3 v-if="item.groupLabel" class="settingsGroupLabel">{{ item.groupLabel }}</h3>
          <button class="settingsItem" type="button" :aria-label="item.id === 'about' && hasDesktopUpdate ? `${item.label}，有新版本可用` : item.label" :aria-pressed="activePanel.id === item.id" @click="activePanel = item">
            <el-badge class="panelIcon" isDot :hidden="item.id !== 'about' || !hasDesktopUpdate">
              <component :is="item.icon" :size="18" aria-hidden="true" />
            </el-badge>
            <span>{{ item.label }}</span>
          </button>
        </template>
      </aside>
      <section class="content" :aria-label="activePanel.label" tabindex="0">
        <h2 class="panelTitle">{{ activePanel.label }}</h2>
        <div class="panelContent">
          <transition name="el-fade-in" mode="out-in">
            <keep-alive include="personalization">
              <component
                :is="activePanel.component"
                v-bind="['pluginMarket', 'languageModel', 'mediaModel', 'personalization'].includes(activePanel.id) ? { visible } : {}" />
            </keep-alive>
          </transition>
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onMounted, shallowRef } from "vue";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import {
  IconPalette,
  IconSettings,
  IconPhotoVideo,
  IconBuildingStore,
  IconInfoCircle,
  IconCode,
  IconShieldLock,
  IconPlugConnected,
  IconUserCog,
  IconSubtitlesAi,
} from "@tabler/icons-vue";

const settingsPanels = [
  { id: "ui", label: "界面设置", icon: IconPalette, component: defineAsyncComponent(() => import("./panels/ui.vue")) },
  { id: "general", label: "常规配置", icon: IconSettings, component: defineAsyncComponent(() => import("./panels/general/index.vue")) },
  {
    id: "languageModel",
    label: "文本模型",
    icon: IconSubtitlesAi,
    groupLabel: "模型",
    component: defineAsyncComponent(() => import("./panels/languageModel/index.vue")),
  },
  { id: "mediaModel", label: "媒体模型", icon: IconPhotoVideo, component: defineAsyncComponent(() => import("./panels/mediaModel/index.vue")) },
  {
    id: "pluginMarket",
    label: "插件市场",
    icon: IconBuildingStore,
    groupLabel: "市场",
    component: defineAsyncComponent(() => import("./panels/pluginMarket/index.vue")),
  },
  { id: "mcp", label: "MCP", icon: IconPlugConnected, groupLabel: "其他", component: defineAsyncComponent(() => import("./panels/mcp/index.vue")) },
  { id: "personalization", label: "个性化", icon: IconUserCog, component: defineAsyncComponent(() => import("./panels/personalization.vue")) },
  { id: "privacy", label: "隐私", icon: IconShieldLock, component: defineAsyncComponent(() => import("./panels/privacy.vue")) },
  { id: "developer", label: "开发者选项", icon: IconCode, component: defineAsyncComponent(() => import("./panels/developer/index.vue")) },
  { id: "about", label: "关于", icon: IconInfoCircle, component: defineAsyncComponent(() => import("./panels/about.vue")) },
];
const activePanel = shallowRef(settingsPanels[0]!);
const visible = defineModel<boolean>({ default: false });

/**
 * 从「设置里点的外链」返回软件时，把设置面板恢复回来。
 *
 * 背景：点「查看余额」「前往 Linke 官网」这类外链，启动器会把 WebView **原地导航**
 * 到外部网页并显示「外部网页」返回条（见 launcher.cs 的 UpdateNavBar/GoBackToApp）。
 * 返回时它只 `Navigate(_lastAppUrl)` —— 也就是「软件内的地址」；而设置弹窗是 SPA
 * 内存里的状态（不在 URL 里），所以回来必然停在首页/画布、弹窗和页签全没了。
 *
 * 做法：在**点外链的那一刻**落一份标记（含当前页签 + 时间），回到软件后自动恢复，
 * 用完即删。用 localStorage 而不是 sessionStorage，是因为它跨"导航到外部域再返回"
 * 一定还在；再加 2 分钟有效期，避免"点了外链但没回来"时下次启动莫名弹出设置。
 */
const RESTORE_KEY = "toonflow:settings-restore";
const RESTORE_TTL = 2 * 60 * 1000;

function onSettingsClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  // 只记真正会离开软件的外链：http(s) 且不是本机服务地址
  // （本机地址只会在软件内跳转，不会触发返回条）
  if (!/^https?:\/\//i.test(href) || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(href)) return;
  try {
    localStorage.setItem(RESTORE_KEY, JSON.stringify({ panel: activePanel.value.id, at: Date.now() }));
  } catch { /* 存储不可用（隐私模式等）就算了，不影响主流程 */ }
}

onMounted(() => {
  let saved: { panel?: unknown; at?: unknown } | null = null;
  try {
    const raw = localStorage.getItem(RESTORE_KEY);
    localStorage.removeItem(RESTORE_KEY);   // 一次性：无论是否有效都清掉
    saved = raw ? JSON.parse(raw) : null;
  } catch { saved = null; }
  if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > RESTORE_TTL) return;
  const panel = settingsPanels.find(item => item.id === saved!.panel);
  if (panel) activePanel.value = panel;
  visible.value = true;
});
</script>

<style lang="scss" scoped>
.settings {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  height: min(72vh, calc(100dvh - 140px));
  overflow: hidden;

  .sidebar {
    min-height: 0;
    overflow-y: auto;
    padding: 2px;

    .settingsGroupLabel {
      margin: 14px 12px 6px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
    }

    .settingsItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: start;
      cursor: pointer;

      .panelIcon { display: inline-flex; flex-shrink: 0; }

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover {
        background: var(--el-fill-color-light);
      }

      &[aria-pressed="true"] {
        /* 选中项：EP 惯例是「主色浅调底 + 主色字」，主色近黑时整项变黑块。
           改用主题中性色，任何主色下都清晰。 */
        background: var(--el-fill-color-dark);
        color: var(--el-text-color-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--ui-brand-foreground, var(--el-color-primary));
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;

    .panelTitle {
      flex-shrink: 0;
      margin: 0 0 20px;
      font-size: 18px;
    }

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-left: 5px;
      padding-right: 5px;
      padding-bottom: 50px;

      > :deep(.el-fade-in-enter-active),
      > :deep(.el-fade-in-leave-active) {
        transition-duration: 100ms;
      }
    }
  }

  @media (max-width: 700px) {
    grid-template-columns: 44px minmax(0, 1fr);

    .sidebar {
      .settingsGroupLabel {
        margin: 12px 0 6px;
        text-align: center;
      }

      .settingsItem {
        justify-content: center;
        padding: 12px;
        span {
          display: none;
        }
      }
    }

    .content {
      padding: 0 8px 0 16px;
    }
  }
}
</style>
