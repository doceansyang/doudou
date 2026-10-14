<template>
  <div class="topActions">
    <!-- 语言 / 设置 / 主题 —— 三颗**同规格图标按钮**。
         首屏（快速开始）与项目列表页共用这一份，避免两页各写一套后走样。 -->
    <languageSelect popover icon-only />
    <el-badge class="badgeWrap" isDot :hidden="!updateBadge">
      <button
        class="topActionButton"
        type="button"
        :aria-label="updateBadge ? '设置，有新版本可用' : '设置'"
        :title="updateBadge ? '设置，有新版本可用' : '设置'"
        @click="emit('open-settings')">
        <IconSettings :size="20" aria-hidden="true" />
      </button>
    </el-badge>
    <button
      class="topActionButton"
      type="button"
      :aria-label="dark ? '切换到浅色主题' : '切换到深色主题'"
      :title="dark ? '切换到浅色主题' : '切换到深色主题'"
      @click="toggleTheme">
      <IconSun v-if="dark" :size="20" aria-hidden="true" />
      <IconMoon v-else :size="20" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { IconMoon, IconSettings, IconSun } from "@tabler/icons-vue";
import { uiSettings, updateUiSettings } from "@/stores/settings";
import languageSelect from "@/components/languageSelect.vue";

/** `updateBadge`：设置那颗要不要挂「有新版本」的红点。 */
withDefaults(defineProps<{ updateBadge?: boolean }>(), { updateBadge: false });
/** 设置面板各页自己持有，所以这里只发信号，不在这里渲染面板。 */
const emit = defineEmits<{ "open-settings": [] }>();

/** 主题是否为深色：`跟随系统` 时按系统实时取值。 */
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(darkQuery.matches);
function onSystemThemeChange(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
const dark = computed(() => (uiSettings.value.theme === "system" ? systemDark.value : uiSettings.value.theme === "dark"));

/**
 * 切换明/深色主题（按钮上的图标表示"点下去会变成哪种"）。
 * 圆形扩散动效与设置面板里那颗**同一套**：圆心取点击坐标，写进 --themeX/--themeY/--themeR。
 */
function toggleTheme(event: MouseEvent) {
  const next = dark.value ? ("light" as const) : ("dark" as const);
  const root = document.documentElement;
  root.style.setProperty("--themeX", `${event.clientX}px`);
  root.style.setProperty("--themeY", `${event.clientY}px`);
  root.style.setProperty("--themeR", `${Math.hypot(Math.max(event.clientX, innerWidth - event.clientX), Math.max(event.clientY, innerHeight - event.clientY))}px`);
  if (!document.startViewTransition) {
    updateUiSettings({ theme: next });
    return;
  }
  document.startViewTransition(async () => {
    updateUiSettings({ theme: next });
    await nextTick();
  });
}

onMounted(() => darkQuery.addEventListener("change", onSystemThemeChange));
onBeforeUnmount(() => darkQuery.removeEventListener("change", onSystemThemeChange));
</script>

<style lang="scss" scoped>
.topActions {
  display: flex;
  align-items: center;
  gap: 8px;

  /* el-badge 默认是 inline-block，会把按钮顶得和另外两颗不齐。 */
  .badgeWrap {
    display: inline-flex;
  }

  /* ⚠️ 圆形/固定尺寸按钮要用原生 button 自己钉死尺寸：走 el-button 会被
     `.el-button.is-circle` 那类高特异性规则顶掉（实测 44×44 渲染成 32×44 的椭圆）。 */
  .topActionButton {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
    background: var(--el-bg-color-overlay);
    color: var(--el-text-color-primary);
    font: inherit;
    cursor: pointer;
    transition: border-color 0.18s, box-shadow 0.18s, background-color 0.18s;

    &:hover {
      border-color: var(--el-color-primary-light-5);
      box-shadow: var(--el-box-shadow-lighter);
    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: 3px;
    }
  }
}
</style>
