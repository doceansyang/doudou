<template>
  <el-config-provider :locale="elementLocale">
    <config-provider :globalConfig="tdesignLocale">
      <router-view v-slot="{ Component: currentComponent }">
        <transition name="el-fade-in">
          <component :is="currentComponent" />
        </transition>
      </router-view>
      <ffmpegRequired />
      <updateBox
        v-if="updateBoxBuild && !installFailure"
        v-model="updateBoxVisible"
        :version="updateBoxBuild.version"
        :buildCode="updateBoxBuild.hash"
        @opened="rememberUpdateBox"
        @close="rememberUpdateBox" />
      <el-dialog v-if="installFailure" v-model="installFailureVisible" title="更新未成功" width="min(520px, 92vw)" alignCenter appendToBody :closeOnClickModal="false">
        <div v-if="installFailure" class="installFailureContent">
          <p class="failureMessage">{{ installFailure.message }}</p>
          <dl class="failureVersions">
            <div>
              <dt>当前运行版本</dt>
              <dd><strong>{{ installFailure.currentVersion ? `v${installFailure.currentVersion}` : "未知版本" }}</strong><code>{{ installFailure.currentHash || "构建标识未知" }}</code></dd>
            </div>
            <div>
              <dt>本次更新目标</dt>
              <dd><strong>{{ installFailure.targetVersion ? `v${installFailure.targetVersion}` : "未知版本" }}</strong><code>{{ installFailure.targetHash || "构建标识未知" }}</code></dd>
            </div>
          </dl>
          <p class="failureHint">请前往 GitHub 最新发布页，选择适合当前系统的完整安装包，关闭客户端后重新安装。</p>
        </div>
        <template #footer>
          <el-button @click="installFailureVisible = false">稍后</el-button>
          <el-button tag="a" type="primary" :href="installFailure.downloadUrl" target="_blank" rel="noopener noreferrer">前往下载页</el-button>
        </template>
      </el-dialog>
    </config-provider>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect } from "vue";
import { ElMessage, useZIndex } from "element-plus";
import { elementLocales } from "@toonflow/i18n/elementPlus";
import { ConfigProvider, type GlobalConfigProvider } from "tdesign-vue-next";
import tdesignZhCn from "tdesign-vue-next/es/locale/zh_CN";
import tdesignZhTw from "tdesign-vue-next/es/locale/zh_TW";
import tdesignEn from "tdesign-vue-next/es/locale/en_US";
import tdesignJa from "tdesign-vue-next/es/locale/ja_JP";
import tdesignRu from "tdesign-vue-next/es/locale/ru_RU";
import tdesignKo from "tdesign-vue-next/es/locale/ko_KR";
import tdesignAr from "tdesign-vue-next/es/locale/ar_KW";
import { locale } from "@toonflow/i18n/vue";
import type { updateSnapshot } from "@toonflow/server/desktop";
import { chatLocale } from "@/lib/i18n";
import { saveSettings, settings, uiSettings } from "@/stores/settings";
import { desktopUpdateSnapshot, desktopUpdateSupported, probeDesktopUpdateSupport, runDesktopUpdate, stopDesktopUpdateObservation } from "@/stores/desktopUpdate";
import { useMcpControl } from "@/lib/mcpControl";
import ffmpegRequired from "@/components/settings/ffmpegRequired.vue";
import updateBox from "@/components/updateBox.vue";
import "element-plus/theme-chalk/dark/css-vars.css";

useMcpControl();

// ACT: TDesign 缺少的语言使用英语基底，聊天控件由应用字典补齐。
const tdesignLocales = {
  "zh-CN": tdesignZhCn, "zh-TW": tdesignZhTw, en: tdesignEn, ja: tdesignJa, ru: tdesignRu, vi: tdesignEn, th: tdesignEn, ko: tdesignKo, hi: tdesignEn,
  id: tdesignEn, ms: tdesignEn, fil: tdesignEn, bn: tdesignEn, ur: tdesignEn, ta: tdesignEn, te: tdesignEn, mr: tdesignEn, pa: tdesignEn, ar: tdesignAr, fa: tdesignEn, tr: tdesignEn,
};
const elementLocale = computed(() => elementLocales[locale.value]);
// ACT: TDesign 自带语言包声明为 readonly，而 ConfigProvider 的只读使用接口声明为可写。
const tdesignLocale = computed(() => ({ ...tdesignLocales[locale.value], chat: chatLocale.value }) as unknown as GlobalConfigProvider);

const updateBoxVisible = ref(false);
const updateBoxBuild = shallowRef<{ version: string; hash: string }>();
const shownUpdateBuilds = new Set<string>();
const installFailureVisible = ref(false);
const installFailure = shallowRef<updateSnapshot["installFailure"]>();
const shownInstallAttempts = new Set<string>();

// 启动时探一次「服务端是否支持检查更新」，支持的话再读一次已知状态
// （read 只读服务端已有状态、不联网），这样上次已发现的新版本能立刻在设置按钮上亮红点。
probeDesktopUpdateSupport().then((supported) => {
  if (supported) void runDesktopUpdate("read").catch(() => undefined);
});

watch(desktopUpdateSnapshot, snapshot => {
  // 不做「检查更新」的部署（纯浏览器）不该弹更新提示 —— 由服务端探测决定，见 store。
  if (!desktopUpdateSupported.value || !snapshot) return;
  if (snapshot.installFailure) {
    installFailure.value = snapshot.installFailure;
    updateBoxVisible.value = false;
    const attemptId = snapshot.installFailure.attemptId;
    if (shownInstallAttempts.has(attemptId)) return;
    shownInstallAttempts.add(attemptId);
    // ACT: 同一 WebView 刷新后仍不重复提醒；退出客户端后新会话可再次提醒。
    try {
      const key = `desktopUpdateFailure:${attemptId}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* 存储不可用时仍按当前页面去重。 */ }
    installFailureVisible.value = true;
    return;
  }
  if (!snapshot.version || !snapshot.hash || snapshot.channel === "dev") return;
  if (installFailure.value) {
    if (snapshot.error || snapshot.updating || snapshot.version !== installFailure.value.targetVersion || snapshot.hash !== installFailure.value.targetHash) return;
    installFailure.value = undefined;
    installFailureVisible.value = false;
  }
  const buildKey = `${snapshot.version}:${snapshot.hash}`;
  const seenBuilds = settings.value.updateBoxSeenBuilds;
  if (shownUpdateBuilds.has(buildKey) || Array.isArray(seenBuilds) && seenBuilds.includes(buildKey)) return;
  shownUpdateBuilds.add(buildKey);
  updateBoxBuild.value = { version: snapshot.version, hash: snapshot.hash };
  updateBoxVisible.value = true;
}, { immediate: true });

function rememberUpdateBox() {
  if (!updateBoxBuild.value) return;
  const buildKey = `${updateBoxBuild.value.version}:${updateBoxBuild.value.hash}`;
  // ACT: 桌面端启动端口会变化，复用应用设置；展示完成或提前关闭时记录，保存队列内去重。
  void saveSettings(current => {
    const seenBuilds = Array.isArray(current.updateBoxSeenBuilds) ? current.updateBoxSeenBuilds.filter(value => typeof value === "string") : [];
    return seenBuilds.includes(buildKey) ? undefined : { updateBoxSeenBuilds: [...seenBuilds, buildKey] };
  }).catch(() => { ElMessage.warning("更新说明的展示记录保存失败，下次启动时可能再次显示。"); });
}

function preventPageZoom(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) event.preventDefault();
}
function preventPageZoomShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ["+", "=", "-", "0"].includes(event.key)) event.preventDefault();
}
// 仅取消浏览器默认缩放，继续传递事件供 Vue Flow 缩放画布。
window.addEventListener("wheel", preventPageZoom, { capture: true, passive: false });
// 画布在捕获阶段先处理自己的快捷键，再在冒泡阶段取消浏览器缩放。
window.addEventListener("keydown", preventPageZoomShortcut);
onBeforeUnmount(() => {
  stopDesktopUpdateObservation();
  window.removeEventListener("wheel", preventPageZoom, true);
  window.removeEventListener("keydown", preventPageZoomShortcut);
});

const { currentZIndex } = useZIndex();
watchEffect(() => document.documentElement.style.setProperty("--markdown-tooltip-z-index", String(currentZIndex.value + 1)));

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(systemTheme.matches);
function updateSystemTheme(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
systemTheme.addEventListener("change", updateSystemTheme);
onBeforeUnmount(() => systemTheme.removeEventListener("change", updateSystemTheme));

/**
 * 求一支「可以安全当文字色用」的品牌色。
 *
 * 背景（真实踩坑）：Element Plus 的选中/悬停态默认是「底色 = 主色浅调(light-9) + 文字 = 主色」。
 * 若主色本身接近纯黑（例如自定义成 #171717），深色主题下浅调底也近乎全黑，
 * 就变成「近黑字 on 近黑底」—— 分段控件（画布/文档）的选中项、下拉菜单悬停项会整块糊掉看不见。
 *
 * 处理：按感知亮度给出一支安全前景色 ——
 *   深色主题下过暗的主色提亮；浅色主题下过亮的主色压暗；正常中间调原样返回（不动视觉）。
 * 这样 #409eff / #a855f7 等预设色完全不受影响，只有会糊掉的颜色被修正。
 */
function readableBrand(color: string, dark: boolean): string {
  const hex = color.replace("#", "").trim();
  if (hex.length !== 6) return color;
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  if (channels.some((value) => Number.isNaN(value))) return color;
  const [r, g, b] = channels as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (dark && luminance < 0.35) return `color-mix(in srgb, ${color} 25%, #e9eaee)`;
  if (!dark && luminance > 0.8) return `color-mix(in srgb, ${color} 30%, #1c1c1e)`;
  return color;
}

watchEffect(() => {
  const { theme, primaryColor, fontScale, radius } = uiSettings.value;
  const dark = theme === "system" ? systemDark.value : theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.setAttribute("theme-mode", dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.fontSize = `${(16 * fontScale) / 100}px`;
  root.style.setProperty("--ui-radius", `${radius}px`);
  root.style.setProperty("--el-color-primary", primaryColor);
  // 供「主色当文字色」的场景使用（选中/悬停态底色是主色浅调，直接用主色会糊）。
  root.style.setProperty("--ui-brand-foreground", readableBrand(primaryColor, dark));
  for (let level = 1; level <= 9; level++) {
    root.style.setProperty(
      `--el-color-primary-light-${level}`,
      `color-mix(in srgb, ${primaryColor} ${100 - level * 10}%, ${dark ? "#141414" : "#fff"})`
    );
  }
  root.style.setProperty("--el-color-primary-dark-2", `color-mix(in srgb, ${primaryColor} 80%, ${dark ? "#fff" : "#000"})`);
  // 桌面外壳在文档创建时会注入一份「防闪白」底色（见 launcher.cs 的 InjectPrepaintTheme），
  // 目的是让整页加载的瞬间就是正确底色、而不是先白一下。到这里真实主题变量已经算好了，
  // 把它撤掉交回 Element Plus，避免它一直 !important 压着 --el-bg-color。
  document.getElementById("jinyu-prepaint")?.remove();
});
</script>

<style lang="scss">
html {
  background-color: var(--el-bg-color);
  color: var(--el-text-color-primary);
}

.installFailureContent {
  .failureMessage {
    margin: 0;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--el-color-danger);
    line-height: 1.7;
  }

  .failureVersions {
    margin: 20px 0;
    padding: 14px;
    display: grid;
    gap: 16px;
    border-radius: var(--ui-radius);
    background: var(--el-fill-color-light);

    > div {
      dt { margin-bottom: 6px; color: var(--el-text-color-secondary); }
      dd {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 5px;
        code { font-size: 12px; overflow-wrap: anywhere; }
      }
    }
  }

  .failureHint { margin: 0; line-height: 1.7; }
}

// ACT: RTL 只改变界面阅读方向，画布坐标、代码和技术值保留从左到右。
.vue-flow,
pre,
code,
input[type="url"],
input[type="email"],
input[type="password"],
input[type="number"],
input[inputmode="numeric"],
input[inputmode="decimal"],
.projectPath,
.locationPath {
  direction: ltr;
  unicode-bidi: isolate;
}

// 主题切换圆形扩散动效，坐标由触发点写入 --themeX/--themeY/--themeR。
::view-transition-old(root),
::view-transition-new(root) {
  animation: none;
  mix-blend-mode: normal;
}

::view-transition-new(root) {
  animation: themeReveal 0.4s ease-in forwards;
}

@keyframes themeReveal {
  from {
    clip-path: circle(0 at var(--themeX) var(--themeY));
  }
  to {
    clip-path: circle(var(--themeR) at var(--themeX) var(--themeY));
  }
}

.vue-flow {
  --vf-node-bg: var(--el-bg-color-overlay);
  --vf-node-text: var(--el-text-color-primary);
  --vf-node-color: var(--el-border-color-darker);
  --vf-connection-path: var(--el-text-color-secondary);
  --vf-handle: var(--el-text-color-secondary);

  .vue-flow__minimap {
    background-color: var(--el-bg-color);
  }
}
</style>
