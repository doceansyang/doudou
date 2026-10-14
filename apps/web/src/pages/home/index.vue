<template>
  <el-container class="home">
    <bg class="pageBackground" />
    <el-header class="pageHeader">
      <!-- 与快速开始页同一组图标按钮（语言 / 设置 / 主题）。
           设置那颗挂「有新版本」红点，逻辑照旧。 -->
      <topActions :update-badge="hasDesktopUpdate" @open-settings="settingsVisible = true" />
    </el-header>
    <el-main class="pageContent">
      <section class="creationPanel" aria-label="创建项目">
        <div class="brand">
          <h1 class="gradientWordmark">JinyuDream</h1>
        </div>
        <div class="promptArea">
          <span class="arrowHint inspirationHint">
            灵感创作模式
            <svg viewBox="0 0 60 60" fill="none" aria-hidden="true">
              <path d="M4 9C21 0 44 5 40 23C36 39 14 34 22 20C30 7 49 21 47 52M38 43L47 52L54 42" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '20px' }" :footerStyle="{ padding: '12px 16px' }">
            <attachmentList v-if="promptAttachments.length" class="promptAttachments" :attachments="promptAttachments" removable restorable :disabled="creating || opening" @remove="promptAttachments.splice($event, 1)" @restore="restoreAttachment" />
            <el-input ref="promptInput" v-model="prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" resize="none" :disabled="creating || opening" :placeholder="promptPlaceholder" aria-label="创作描述" @paste.capture="pasteText" />
            <template #footer>
              <div class="composerFooter">
                <workspacePicker ref="promptWorkspacePicker" v-model="workspaceDirectory" :disabled="creating || opening" />
                <el-space class="sendActions" wrap :size="12">
                  <modelPopover v-model="selectedModel" v-model:reasoningEffort="reasoningEffort" class="modelSelect" :disabled="creating || opening" />
                  <!-- 恒定圆形：早先没有工作目录时，这颗按钮会变形成「文件夹图标 + 选择工作目录」
                       的长条，一选完目录又跳回圆形，整条 footer 跟着左右乱动。
                       改成尺寸恒定，操作提示交给下方常驻的 workspaceHint 承担。 -->
                  <el-button class="sendButton" type="primary" circle :icon="workspaceDirectory ? IconArrowUp : IconFolder" :loading="creating" :disabled="creating || opening" :aria-label="workspaceDirectory ? '发送' : '选择工作目录'" @click="workspaceDirectory ? createProject() : promptWorkspacePicker?.chooseDirectory()" />
                </el-space>
              </div>
              <p v-if="!workspaceDirectory" class="workspaceHint" role="status">请先选择一个空文件夹作为工作目录，画布和素材会保存在这里。</p>
            </template>
          </el-card>
        </div>
      </section>
      <section class="projectList" aria-labelledby="projectListTitle">
        <div class="sectionHeader">
          <h2 id="projectListTitle">项目列表</h2>
          <el-space wrap>
            <!-- 措辞对齐真实行为：前者是「选一个已有目录打开」，后者是「新建一个空项目」。
                 原来的「导入项目 / 添加项目」两个名字都不达意，用户分不清该点哪个。 -->
            <el-button :icon="IconFolderOpen" :disabled="creating || opening" @click="openProject()" title="选择一个已有文件夹并打开">打开项目</el-button>
            <el-button :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject(false)" title="选择一个空文件夹作为新项目">新建项目</el-button>
            <el-button circle :icon="sortDescending ? IconSortDescending : IconSortAscending" :aria-label="sortDescending ? '按时间降序' : '按时间升序'" @click="sortDescending = !sortDescending" />
            <el-radio-group v-model="viewMode" aria-label="项目视图">
              <el-radio-button value="grid" aria-label="网格视图"><icon-layout-grid :size="16" /></el-radio-button>
              <el-radio-button value="list" aria-label="列表视图"><icon-list :size="16" /></el-radio-button>
            </el-radio-group>
          </el-space>
        </div>
        <div class="projectItems" :class="{ listView: viewMode === 'list' }">
          <div v-if="!sortedProjects.length" class="projectEmpty" role="status">
            <icon-folder-open :size="30" aria-hidden="true" />
            <p class="projectEmptyTitle">还没有项目</p>
            <p>在上方描述你的创意并发送，或点「新建项目」选一个空文件夹开始。</p>
          </div>
          <el-card v-for="project in sortedProjects" :key="project.directory" class="projectCard" shadow="hover" :bodyStyle="{ padding: '0' }">
            <button class="projectEntry" type="button" :disabled="creating || opening" :aria-label="`打开项目 ${project.name}`" @click="openProject(project)">
              <icon-folder class="projectIcon" :size="28" aria-hidden="true" />
              <span class="projectInfo">
                <span class="projectName" :title="project.name">{{ project.name }}</span>
                <span class="projectPath" :title="project.directory">{{ shortPath(project.directory) }}</span>
                <span class="projectTime" :title="new Date(project.lastOpenedAt).toLocaleString(locale, { hour12: false })">最近打开 {{ relativeTime(project.lastOpenedAt) }}</span>
              </span>
            </button>
            <div class="projectActions">
              <el-button text :icon="IconEdit" :disabled="creating || opening" :aria-label="`重命名项目 ${project.name}`" title="重命名" @click="renameProject(project)" />
              <el-button text type="danger" :icon="IconTrash" :disabled="creating || opening" :aria-label="`移除项目 ${project.name}`" title="从列表移除，不删除文件" @click="workspaceStore.removeProject(project.directory)" />
            </div>
          </el-card>
        </div>
      </section>
    </el-main>
    <settings v-model="settingsVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </el-container>
</template>

<script setup lang="ts">
import { locale, translate } from "@toonflow/i18n/vue";
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import {
  IconArrowUp, IconLayoutGrid,
  IconList, IconSortDescending,
  IconSortAscending, IconFolder, IconEdit,
  IconTrash, IconFolderPlus, IconFolderOpen,
} from "@tabler/icons-vue";
import modelPopover from "@/components/modelPopover.vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "@/components/agent/textAttachments";
import type { AgentAttachment } from "@/components/agent/types";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import settings from "@/components/settings/index.vue";
import topActions from "@/components/topActions.vue";
import bg from "./bg.vue";
import workspacePicker from "./workspacePicker.vue";

const settingsVisible = ref(false);
const router = useRouter();
const creating = ref(false);
const opening = ref(false);
const promptWorkspacePicker = ref<InstanceType<typeof workspacePicker>>();
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const prompt = ref("");
const promptInput = ref<InputInstance>();
const promptAttachments = ref<AgentAttachment[]>([]);
const workspaceStore = useWorkspaceStore();
const { project, projectList } = storeToRefs(workspaceStore);
const workspaceDirectory = ref(project.value?.directory ?? "");
const placeholderPhrases = [
  "描述你想创作的内容，让灵感从这里开始…",
  "把一个故事灵感，变成一段精彩的短片…",
  "为你的主角设计独特的外形和性格…",
  "创作一段雨夜街头的电影感镜头…",
  "把这段文字拆解成连贯的分镜画面…",
  "为一场奇幻冒险生成场景和角色…",
  "为你的画面配上一段合适的音乐…",
  "写一段温暖的旁白，讲述这个故事…",
  "设计一支富有想象力的产品宣传片…",
  "从一句话开始，搭建你的创作工作流…",
];
const promptPlaceholder = ref(translate(placeholderPhrases[0]!));

onMounted(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let phraseIndex = 0;
  watch([() => !!prompt.value, locale], ([hasInput], _previous, onCleanup) => {
    if (reduceMotion) {
      promptPlaceholder.value = translate(placeholderPhrases[0]!);
      return;
    }
    if (hasInput) return;
    const segmenter = new Intl.Segmenter(locale.value, { granularity: "grapheme" });
    const phrases = placeholderPhrases.map(phrase => [...segmenter.segment(translate(phrase))].map(part => part.segment));
    let characterCount = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    promptPlaceholder.value = "";

    function typePlaceholder() {
      const phrase = phrases[phraseIndex]!;
      characterCount += deleting ? -1 : 1;
      promptPlaceholder.value = phrase.slice(0, characterCount).join("");
      let delay = deleting ? 35 : 85;
      if (characterCount === phrase.length) {
        deleting = true;
        delay = 1800;
      } else if (characterCount === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % placeholderPhrases.length;
        delay = 300;
      }
      timer = setTimeout(typePlaceholder, delay);
    }

    timer = setTimeout(typePlaceholder, 300);
    onCleanup(() => clearTimeout(timer));
  }, { immediate: true });
});

const selectedModel = ref("");
const reasoningEffort = ref("");
const sortDescending = ref(true);
const viewMode = ref("grid");
const sortedProjects = computed(() => [...projectList.value].sort((left, right) =>
  sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt
));

function pasteText(event: ClipboardEvent) {
  if (creating.value || opening.value) return;
  try {
    const file = createPastedTextFile(event.clipboardData?.getData("text/plain") ?? "");
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (promptAttachments.value.length >= 20) return ElMessage.warning("每条消息最多添加 20 个附件");
    promptAttachments.value.push({ name: file.name, path: "", mimeType: file.type, file });
  } catch (error) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ElMessage.error(error instanceof Error ? error.message : "添加文本附件失败，请重试");
  }
}

async function restoreAttachment(index: number) {
  const attachment = promptAttachments.value[index];
  if (!attachment || creating.value || opening.value) return;
  try {
    const text = await readTextAttachment(attachment);
    const currentIndex = promptAttachments.value.indexOf(attachment);
    if (currentIndex < 0 || creating.value || opening.value) return;
    prompt.value += `${prompt.value ? "\n" : ""}${text}`;
    promptAttachments.value.splice(currentIndex, 1);
    await nextTick();
    promptInput.value?.focus();
    promptInput.value?.textarea?.setSelectionRange(prompt.value.length, prompt.value.length);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "取回文本失败，请重试");
  }
}

async function openProject(project?: Project) {
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    const directory = project?.directory ?? await relocationPicker.value?.chooseDirectory();
    if (!directory) return;
    try { await workspaceStore.openProject(directory); }
    catch (err) {
      if (!project || !axios.isAxiosError(err) || err.response?.status !== 404) throw err;
      const reselect = await ElMessageBox.confirm(`项目“${project.name}”的文件夹不存在，是否重新选择文件夹？`, "工作目录不存在", {
        confirmButtonText: "重新选择", cancelButtonText: "取消", type: "warning",
      }).then(() => true, () => false);
      if (!reselect) return;
      const directory = await relocationPicker.value?.chooseDirectory();
      if (!directory) return;
      await workspaceStore.openProject(directory, project.directory);
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "无法打开项目，请重试"
      : err instanceof Error ? err.message : "无法打开项目，请重试");
  } finally { opening.value = false; }
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称（同时会重命名项目文件夹）", "重命名项目", {
    inputValue: project.name, confirmButtonText: "保存", cancelButtonText: "取消",
    inputValidator: value => {
      const name = value?.trim();
      if (!name) return "项目名称不能为空";
      return !/[\\/:*?"<>|]/.test(name) || "名称不能包含 \\ / : * ? \" < > |";
    },
  }).catch(() => null);
  if (!result) return;
  const name = result.value.trim();
  if (!name || name === project.name) return;

  // 项目名 = 文件夹名，所以改名必须同步重命名文件夹，
  // 否则「选择空间」显示的还是旧目录名、项目列表显示新名字，用户看到两套名字。
  const normalized = project.directory.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (cut > 0) {
    const parent = normalized.slice(0, cut);
    const base = normalized.slice(cut + 1);
    try {
      await useWorkspaceFiles(parent).rename(base, name);
      workspaceStore.renameProject(project.directory, name, `${parent}\\${name}`);
      return;
    } catch (error) {
      ElMessage.warning(axios.isAxiosError<{ message?: string }>(error)
        ? `${error.response?.data?.message || "无法重命名文件夹"}，已只更新显示名称`
        : "无法重命名文件夹，已只更新显示名称");
    }
  }
  workspaceStore.renameProject(project.directory, name);
}

/**
 * 两个目录是否指向同一处（忽略分隔符方向、结尾斜杠与大小写）。
 *
 * 首页的「工作目录」会预填上次打开的项目，而项目目录又可能被写成
 * `D:\x\y` 或 `D:/x/y/`，直接字符串比较会认成两个不同的目录。
 */
function sameDirectory(left: string, right: string) {
  const normalize = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return !!left && !!right && normalize(left) === normalize(right);
}

/**
 * 卡片上只显示路径的「盘符 + 末两级」。
 *
 * 为什么不能直接铺完整路径：一是会被 CSS 截成 `C:\Users\JinYuDream\AppDa…`，
 * 用户读不出这个项目到底在哪；二是**本机用户名会跟着露出来**，截图分享即隐私泄露。
 * 完整路径仍放在 title 里，悬停可看。
 */
function shortPath(directory: string) {
  const parts = (directory ?? "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return directory;
  return `${parts[0]}\\…\\${parts.slice(-2).join("\\")}`;
}

/**
 * 把「最近打开」压成相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期）。
 * 原先精确到秒（`2026/10/12 11:32:29`），信息密度低又占满一整行。精确时间留在 title 里。
 */
function relativeTime(timestamp: number) {
  if (!timestamp) return "未知";
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toLocaleDateString(locale.value, { hour12: false });
}

async function createProject(fromPrompt = true) {
  if (creating.value || opening.value || (fromPrompt && !workspaceDirectory.value)) return;
  creating.value = true;
  try {
    let path = workspaceDirectory.value;
    if (!fromPrompt) {
      const confirmed = await ElMessageBox.confirm("请选择一个空文件夹作为项目目录，画布和素材将保存在其中。", "添加项目", {
        confirmButtonText: "选择空文件夹", cancelButtonText: "取消", type: "info",
      }).then(() => true, () => false);
      if (!confirmed) return;
      path = await relocationPicker.value?.chooseDirectory() ?? "";
      if (!path) return;
    }
    const { directory, empty } = await useWorkspaceFiles(path).list();
    if (!empty) {
      // 目录就是项目列表里的某个项目 → 用户点「发送」其实是想继续这个项目，
      // 直接打开它。否则会丢一句「文件夹不为空」把人挡回去 —— 因为首页的
      // 工作目录会预填上次打开的项目，那目录必然非空，等于一点就报错。
      const existing = projectList.value.find(item => sameDirectory(item.directory, directory));
      if (existing) {
        await workspaceStore.openProject(existing.directory);
        await router.push("/workspace");
        return;
      }
      return ElMessage.warning("该文件夹不为空，无法作为新项目目录。请选择空文件夹，或用「导入项目」把它登记为项目。");
    }
    await useWorkspaceFiles(directory).writeJson("画布1.json", { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
    await workspaceStore.openProject(directory);
    if (fromPrompt && (prompt.value.trim() || promptAttachments.value.length)) {
      workspaceStore.pendingAgentMessage = { directory: workspaceStore.project!.directory, prompt: prompt.value, attachments: [...promptAttachments.value], model: selectedModel.value, reasoningEffort: reasoningEffort.value };
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "创建项目失败，请重试"
      : err instanceof Error ? err.message : "创建项目失败，请重试");
  } finally {
    creating.value = false;
  }
}
</script>

<style lang="scss" scoped>
// 毛玻璃质感（对齐参考图里的悬浮条）：半透明底 + 背景模糊 + 一道极淡描边 + 顶部内高光。
//
// 为什么用 color-mix 而不是写死 rgba：玻璃的底色必须跟着主题走
//   （深色主题＝近黑玻璃、浅色主题＝白玻璃），否则换主题就得改样式，且容易漏。
// 透明度是真机量过的：卡片面 62% 时，底下那片波浪即使最亮处也能让正文保持 12:1 以上；
//   再淡就会让波浪的亮部透出来压住文字（本项目在「文字压背景」上反复踩过）。
@mixin glass($alpha: 60%, $blur: 20px) {
  background-color: color-mix(in srgb, var(--el-bg-color) #{$alpha}, transparent);
  backdrop-filter: blur($blur) saturate(160%);
  -webkit-backdrop-filter: blur($blur) saturate(160%);
  border-color: color-mix(in srgb, var(--el-text-color-primary) 12%, transparent);
  box-shadow:
    0 12px 34px -18px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
}

.home {
  position: relative;
  isolation: isolate;
  min-height: 100dvh;
  color: var(--el-text-color-primary);

  .pageBackground {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
  }

  .arrowHint {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 4px;
    // 用可读品牌前景色而不是主色本身：主色被设成近黑（#171717）时，
    // 这两条手绘提示会变成「黑字压深色底」直接隐形（本项目反复踩的那类问题）。
    color: var(--ui-brand-foreground, var(--el-color-primary));
    font-size: 13px;
    white-space: nowrap;
    pointer-events: none;

    // 去掉了常驻的左右摆动（原 hintNudge 2.4s 无限循环）：首页本来就有
    // 「品牌字渐变流动」和「占位符打字机」两个常驻动画，三处同时动太吵。
    // 手绘箭头的形态保留，只是不再动。
    svg {
      width: 56px;
      height: 30px;
      flex-shrink: 0;
    }
  }

  // 顶栏只保留一颗「设置」胶囊按钮：整条工具栏不再展示（没有 GitHub 入口、没有手绘提示），
  // 也不再套玻璃面 —— 用户要求「这条不要展示」。
  .pageHeader {
    display: flex;
    align-items: center;
    /* 图标组贴右上角（原来只有一颗「设置」时是靠左的，现在与快速开始页对齐到右侧）。 */
    justify-content: flex-end;
    height: 68px;
    margin: 16px clamp(16px, 3.2vw, 48px) 0;
    padding: 0;
  }

  .pageContent {
    padding: 24px clamp(20px, 4vw, 56px) 56px;

    .creationPanel {
      // 与 .projectList 用同一个宽度：原先 800 vs 1040 会让上下两块的左边缘错开一截，
      // 页面看着没对齐。统一到 1040 后，输入区与项目列表左右边界齐平。
      max-width: 1040px;
      margin: clamp(32px, 6vh, 64px) auto 56px;

      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 36px;

        // 品牌字：渐变文字（参考 ReactBits Gradient Text 的默认值）
        //   colors = ["#5227FF", "#FF9FFC", "#B497CF"]，并把首色重复到末尾 —— 循环处才接得上、不跳色
        //   8 秒一个来回（yoyo）、angle 90（左→右）、scale 3（色带更宽更平稳）
        // 实现就是「把渐变当文字的填充色」：background-clip:text + 文字透明，再动画 background-position。
        .gradientWordmark {
          margin: 0;
          font-size: clamp(34px, 4.6vw, 46px);
          font-weight: 600;
          letter-spacing: -1px;
          background-image: linear-gradient(90deg, #5227ff, #ff9ffc, #b497cf, #5227ff);
          background-size: 300% 100%;
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
          animation: wordmarkFlow 8s ease-in-out infinite alternate;

          @media (prefers-reduced-motion: reduce) {
            animation: none;
            background-position: 50% 50%;
          }
        }
      }

      .promptArea {
        position: relative;

        .inspirationHint {
          bottom: calc(100% + 4px);
          left: 16px;
          height: 30px;
          padding-right: 44px;

          svg {
            position: absolute;
            top: -2px;
            right: 0;
            width: 36px;
            height: 36px;
          }
        }

        .promptCard {
          // 玻璃面。EP 卡片的底色走 --el-card-bg-color，直接给它半透明值：
          // 这样无论 EP 自身的规则还是本文件的规则生效顺序如何，结果都是同一块玻璃色。
          --el-card-bg-color: color-mix(in srgb, var(--el-bg-color) 62%, transparent);
          border: 1px solid transparent;
          border-radius: calc(var(--ui-radius) * 2.5);
          @include glass(62%, 24px);

          &:focus-within {
            border-color: color-mix(in srgb, var(--el-color-primary-light-5) 65%, transparent);
          }

          .promptAttachments {
            margin-bottom: 12px;
          }

          :deep(.el-textarea__inner) {
            padding: 4px 0;
            box-shadow: none;
            background: transparent;
            font-size: 15px;
            line-height: 1.8;
          }

          :deep(.el-card__footer) {
            // 页脚原本是实色填充，会把玻璃感整块盖掉 → 改成更淡的一层，保留通透
            background: color-mix(in srgb, var(--el-bg-color) 30%, transparent);
          }

          .composerFooter {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;

            .sendActions {
              margin-left: auto;
              justify-content: flex-end;

              .modelSelect {
                width: 190px;
              }

              .sendButton {
                height: 36px;

                &.is-circle { width: 36px; }
              }
            }
          }

          .workspaceHint {
            margin: 12px 0 0;
            color: var(--el-text-color-regular);
            font-size: 13px;
            line-height: 1.6;
          }
        }
      }
    }

    .projectList {
      max-width: 1040px;
      margin: 0 auto;

      .projectItems {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: 16px;
        margin-top: 16px;

        &.listView { grid-template-columns: 1fr; }

        // 空状态：原先项目为 0 时这里是一整块空白，没有任何引导。
        .projectEmpty {
          grid-column: 1 / -1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 44px 24px;
          border: 1px dashed var(--el-border-color);
          border-radius: calc(var(--ui-radius) * 2);
          color: var(--el-text-color-secondary);
          text-align: center;

          svg { color: var(--el-text-color-secondary); }

          p { margin: 0; font-size: 13px; line-height: 1.7; }
          .projectEmptyTitle { margin-top: 8px; font-size: 15px; font-weight: 600; color: var(--el-text-color-primary); }
        }

        .projectCard {
          position: relative;
          // 项目卡片同样是玻璃面（它压在波浪亮部上，62% 是实测能压住底噪的下限）
          --el-card-bg-color: color-mix(in srgb, var(--el-bg-color) 62%, transparent);
          border: 1px solid transparent;
          @include glass(62%, 18px);

          .projectActions {
            position: absolute;
            top: 12px;
            right: 8px;
            display: flex;
            gap: 4px;
            // 默认隐去：常驻的红色删除按钮在深色卡片上过于抢眼，而且贴在手最容易点到的地方。
            // 卡片悬停 / 键盘聚焦时再浮出（:focus-within 保证 Tab 也能操作到）。
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.16s ease;

            .el-button { width: 32px; height: 32px; margin: 0; padding: 0; }
          }

          &:hover .projectActions,
          &:focus-within .projectActions {
            opacity: 1;
            pointer-events: auto;
          }

          // 触屏设备没有 hover，常驻显示，否则这两个操作永远点不到
          @media (hover: none) {
            .projectActions { opacity: 1; pointer-events: auto; }
          }
        }

        .projectEntry {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          width: 100%;
          padding: 20px 84px 20px 20px;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;

          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
          &:disabled { cursor: wait; opacity: 0.6; }

          // ⚠️ 必须用可读品牌前景色，**不能**直接用主色：
          //    主色被设成近黑 #171717 时，这个图标会变成「比卡片底更暗的轮廓」——
          //    实测该区域最亮像素只有 (42,38,55)，比卡片底高不了几级，几乎看不见。
          //    （与本文件 arrowHint 是同一个坑，那边早就改过了，这里漏了。）
          .projectIcon { flex-shrink: 0; color: var(--ui-brand-foreground, var(--el-color-primary)); }

          .projectInfo {
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;

            .projectName, .projectPath {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .projectName { font-weight: 600; }
            .projectPath { font-size: 13px; color: var(--el-text-color-regular); }
            .projectTime { font-size: 12px; color: var(--el-text-color-secondary); }
          }
        }
      }

      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--el-border-color-lighter);

        h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
      }
    }
  }
}

// 品牌字的渐变流动：从 0% 移到 100% 再回到 0%（animation-direction: alternate 即 yoyo）
@keyframes wordmarkFlow {
  from { background-position: 0% 50%; }
  to { background-position: 100% 50%; }
}
</style>
