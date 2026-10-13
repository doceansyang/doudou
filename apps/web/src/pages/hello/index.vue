<template>
  <main class="hello" :class="{ configuring: view !== 'welcome' }">
    <div class="pageLanguage"><languageSelect popover /></div>
    <section class="welcomePanel" aria-labelledby="welcomeTitle">
      <div v-if="view !== 'welcome'" class="providerContent">
        <header class="providerHeader">
          <el-button text :icon="IconArrowLeft" :disabled="saving" @click="view = 'welcome'">返回</el-button>
          <h1 id="welcomeTitle">{{ view === "login" ? "登录 Linke" : "配置语言模型" }}</h1>
        </header>
        <div v-if="view === 'login'" v-loading="saving" class="loginBody" element-loading-text="正在配置文本模型和媒体模型…">
          <iframe ref="loginFrame" class="loginFrame" :src="loginUrl" title="Linke 登录与注册" />
        </div>
        <div v-else class="providerBody">
          <languageModel />
        </div>
        <div v-if="view === 'login' && loginError" class="loginFeedback" role="status">
          <el-alert :title="loginError" type="error" :closable="false" showIcon />
          <el-button v-if="loginKey" type="primary" :loading="saving" @click="configureProviders">重试配置</el-button>
        </div>
        <el-button
          v-else-if="view === 'custom'"
          type="primary"
          :loading="saving"
          :disabled="!customProviders.some((provider) => provider.models.length)"
          @click="completeSetup">
          开始使用
        </el-button>
      </div>
      <div v-else class="welcomeContent">
        <h1 id="welcomeTitle">快速开始</h1>
        <p class="description">无需注册。自动获取本机已登录的豆包账号；没有会为你打开登录窗口，扫码一次即可开始。</p>

        <!-- 两个动作按钮**同一规格**（宽/高/内边距/圆角/字号/字重完全一致），
             先后顺序即主次：先「用本地豆包账号」，再「登录 Linke」。 -->
        <el-button class="actionButton" type="primary" :loading="saving" @click="useLocalAccount">
          <icon-cloud-download class="buttonIcon" />
          一键获取本地账号
        </el-button>
        <el-button class="actionButton" type="primary" :loading="saving" @click="openLogin">
          <icon-login class="buttonIcon" />
          登录 Linke 自动配置
        </el-button>
        <div class="secondaryActions">
          <el-button class="secondaryButton" round @click="view = 'custom'">
            <icon-key class="buttonIcon" />
            添加私有提供商
          </el-button>
          <span class="separator">或</span>
          <el-button class="secondaryButton laterButton" round :loading="saving" @click="completeSetup">稍后配置</el-button>
        </div>
      </div>

      <footer class="pageFooter">
        <p>© {{ new Date().getFullYear() }} JinyuTV · 保留所有权利。</p>
      </footer>
    </section>
    <div class="artPanel" aria-hidden="true">
      <bg class="artBg" />
      <div class="artBrand">
        <span class="artLogo" v-html="logoSvg" />
        <span class="artName">JinyuTV</span>
      </div>
    </div>

    <!-- 等待扫码：登录窗是**独立的操作系统窗口**（不是本页里的弹层），
         这一层只负责「告诉用户去哪儿操作 + 让等待可以取消」。 -->
    <div v-if="scanning" class="scanOverlay" role="status" aria-live="polite">
      <div class="scanCard">
        <span class="scanSpinner" aria-hidden="true" />
        <h2>请在窗口里扫码登录豆包</h2>
        <p>登录窗口已经为你打开（若没看到，请在任务栏里找一下）。登录完成后会自动继续，也可以直接点「完成」。账号只保存在本机。</p>
        <p class="scanTip">
          <strong>想一次加多个豆包账号？</strong>在该窗口里点头像 →「更多账号」→「添加账号」，把号都登好再点「完成」，它们会一起进来。
        </p>
        <div class="scanActions">
          <el-button type="primary" round :loading="finishing" @click="finishScan">{{ finishing ? "正在读取…" : "完成" }}</el-button>
          <el-button round :disabled="finishing" @click="cancelScan">取消</el-button>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { defineAsyncComponent, onMounted, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { IconArrowLeft } from "@tabler/icons-vue";
import JinyuDream from "@toonflow/providers/language/JinyuDream";
import JinyuDreamSource from "@toonflow/providers/media/JinyuDream?raw";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import { customProviders, saveSettings } from "@/stores/settings";
import type { MediaProvider } from "@/components/settings/panels/mediaModel/types";
import { useHelloStore } from "@/stores/hello";
import anonymousData from "@/lib/anonymousData";
import logoSvg from "@toonflow/assets/logo.svg?raw";
import bg from "./bg.vue";
import languageSelect from "@/components/languageSelect.vue";

const languageModel = defineAsyncComponent(() => import("@/components/settings/panels/languageModel/index.vue"));
const view = ref<"welcome" | "login" | "custom">("welcome");
const loginUrl = ref("https://api.linke.link/login?type=toonflow");
const loginOrigin = new URL(loginUrl.value).origin;
const loginFrame = ref<HTMLIFrameElement>();
const loginKey = ref("");
const loginError = ref("");
const saving = ref(false);
const router = useRouter();
const hello = useHelloStore();
let loginRequest: AbortController | undefined;

function openLogin() {
  const url = new URL(loginUrl.value);
  const pageStyle = getComputedStyle(document.documentElement);
  url.searchParams.set("bgcolor", "white");
  url.searchParams.set("txtcolor", pageStyle.getPropertyValue("--el-color-primary").trim());
  loginUrl.value = url.href;
  loginKey.value = loginError.value = "";
  view.value = "login";
}

/* -------------------------------------------------- 一键获取本地账号 */

/** 本机豆包账号池服务（随主服务自动启动），与 provider 里的默认地址一致。 */
const RPA_URL = "http://127.0.0.1:18077";
/** 扫码等待上限，与后端 openLogin 的 LOGIN_TIMEOUT_MS 对齐（10 分钟）。 */
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

type LocalAccount = { id: string; name: string; hasLoggedIn: boolean; remaining: number };

/** 是否正在等用户扫码（决定遮罩与取消入口）。 */
const scanning = ref(false);
/** 用户是否已点「完成」，正在等后端把登录态读出来。 */
const finishing = ref(false);
let scanCancelled = false;

async function fetchLocalAccounts(timeout = 6000): Promise<LocalAccount[]> {
  const response = await axios.get<{ accounts?: LocalAccount[] }>(`${RPA_URL}/accounts`, { timeout });
  return Array.isArray(response.data?.accounts) ? response.data.accounts : [];
}

/** RPA 服务当前是否在忙（扫码登录期间为 true；登录窗被关掉后会变回 false）。 */
async function fetchRpaBusy(): Promise<boolean | null> {
  try {
    const response = await axios.get<{ busy?: boolean }>(`${RPA_URL}/health`, { timeout: 4000 });
    return typeof response.data?.busy === "boolean" ? response.data.busy : null;
  } catch {
    return null;
  }
}

/** 能直接用的账号：已登录 + 今天还有额度。 */
function pickUsable(accounts: LocalAccount[]): LocalAccount | undefined {
  return accounts.find(account => account.hasLoggedIn && account.remaining > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms); });
}

async function enterWorkspace(accountName?: string) {
  await hello.complete();
  anonymousData.track("onboarding.complete");
  ElMessage.success(accountName ? `已获取本地账号：${accountName}` : "已开始使用");
  await router.replace("/home");
}

/**
 * 「一键获取本地账号」——**新老用户共用这一个按钮**：
 *   1) 本机账号池里有可用账号 → 直接用，进创作；
 *   2) 没有（新用户）→ **自动打开豆包登录窗口**（窗口会置顶），扫码一次即完成，
 *      登录成功后自动继续，用户不需要去别处装任何东西。
 *
 * ⚠️ 为什么不能「直接读用户在别处登录的账号」：浏览器从 Chromium 127 起对 cookie 库
 * 启用 App-Bound 加密，外部程序离线解不开，绕过它要提权或注入浏览器（我们不做）。
 * 所以「一键」的准确含义是：**软件替你打开登录窗口 + 自动检测登录结果**；
 * 扫码一次后登录态长期留在本机，之后完全不用再登。
 */
async function useLocalAccount() {
  if (saving.value || scanning.value) return;
  saving.value = true;
  try {
    let accounts: LocalAccount[];
    try {
      accounts = await fetchLocalAccounts();
    } catch {
      ElMessage.warning("没连上本机的豆包服务，请稍后重试；或先用「登录 Linke 自动配置」。");
      return;
    }
    const ready = pickUsable(accounts);
    if (ready) {
      await enterWorkspace(ready.name);
      return;
    }

    // 没有可用账号 —— 打开登录窗口等扫码（新用户就是在这一步「获取」）。
    if (!(await openScanLogin())) return; // 取消 / 超时 / 窗口被关，原因已在里面说明
    const after = await fetchLocalAccounts().catch(() => [] as LocalAccount[]);
    const picked = pickUsable(after) ?? after.find(account => account.hasLoggedIn);
    await enterWorkspace(picked?.name);
  } catch {
    ElMessage.error("获取本地账号失败，请重试");
  } finally {
    saving.value = false;
  }
}

/**
 * 打开豆包登录窗并等登录完成，返回是否登录成功。
 *
 * 后端的 `POST /accounts` 是个**长请求**（登录窗要一直开着，最长 10 分钟），
 * 所以这里**不等它返回**，改为轮询账号池 —— 一出现账号就立刻继续，最跟手；
 * 同时看 `/health` 的 busy 标志，窗口被关掉或等待结束就收工，不让用户对着遮罩空等。
 */
async function openScanLogin(): Promise<boolean> {
  scanning.value = true;
  finishing.value = false;
  scanCancelled = false;
  // 这个 POST 没人 await，失败必须自己吞掉，否则控制台会报未捕获异常。
  void axios
    .post(`${RPA_URL}/accounts`, { accountType: "doubao" }, { timeout: SCAN_TIMEOUT_MS + 20000 })
    .catch(() => undefined);
  try {
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    let opened = false;
    let idle = 0;
    while (Date.now() < deadline) {
      await delay(2000);
      if (scanCancelled) return false;

      const list = await fetchLocalAccounts().catch(() => [] as LocalAccount[]);
      if (list.some(account => account.hasLoggedIn)) return true;

      const busy = await fetchRpaBusy();
      if (busy === true) {
        opened = true;
        idle = 0;
        continue;
      }
      if (busy === false) {
        // 起浏览器要一点时间；还没等到窗口打开就先多等两轮。
        if (!opened && ++idle < 4) continue;
        ElMessage.warning(opened ? "登录窗口已关闭，还没完成登录。可以再点一次「一键获取本地账号」。" : "没能打开登录窗口，请重试。");
        return false;
      }
    }
    ElMessage.warning("等待扫码超时了，可以再点一次「一键获取本地账号」。");
    return false;
  } finally {
    scanning.value = false;
    finishing.value = false;
  }
}

/**
 * 用户点「完成」：通知后端立刻收工并把登录窗里的账号全部读出来。
 *
 * **不用在这里等结果** —— 后端落库后，`openScanLogin` 的轮询会看到账号并自动进入。
 * 这条也支持「一次加多个账号」：用户可以先在窗口里用「更多账号 → 添加账号」多登几个，
 * 登完再点「完成」，它们会一起进来（跟从本机浏览器拉取是同一条落库路径）。
 */
async function finishScan() {
  if (finishing.value) return;
  finishing.value = true;
  await axios.post(`${RPA_URL}/accounts/finish-login`, {}, { timeout: 8000 }).catch(() => undefined);
}

/** 取消扫码：必须通知后端 —— 否则它会一直等到 10 分钟超时，期间不让再登录。 */
async function cancelScan() {
  scanCancelled = true;
  await axios.post(`${RPA_URL}/accounts/cancel-login`, {}, { timeout: 5000 }).catch(() => undefined);
  ElMessage.info("已取消登录");
}

async function completeSetup() {
  if (saving.value) return;
  saving.value = true;
  try {
    await hello.complete();
    anonymousData.track(view.value === "custom" ? "onboarding.complete" : "onboarding.skip");
    await router.replace("/home");
  } catch {
    ElMessage.error("保存引导状态失败，请重试");
  } finally {
    saving.value = false;
  }
}

function receiveLogin(event: MessageEvent) {
  if (view.value !== "login" || saving.value || event.origin !== loginOrigin || event.source !== loginFrame.value?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object" || !["register", "login"].includes(data.type)) return;
  if (data.msg === "failed") {
    loginKey.value = "";
    loginError.value = typeof data.error === "string" && data.error.trim() ? data.error : data.type === "register" ? "注册失败" : "登录失败";
    return;
  }
  if (data.msg !== "success") return;
  loginError.value = "";
  if (data.type === "register") {
    ElMessage.success("注册成功，请继续登录以自动配置模型");
    return;
  }
  if (typeof data.key !== "string" || !data.key.trim() || data.key.length > 8192) {
    loginKey.value = "";
    loginError.value = "登录未返回有效的 API Key，请重新登录";
    return;
  }
  loginKey.value = data.key.trim();
  void configureProviders();
}

async function configureProviders() {
  if (saving.value || !loginKey.value) return;
  saving.value = true;
  loginError.value = "";
  const apiKey = loginKey.value;
  const request = new AbortController();
  loginRequest = request;
  try {
    const mediaResponse = await axios.get<{ code: number; data: MediaProvider[] }>("/api/providers/media/list", { signal: request.signal });
    if (mediaResponse.data.code !== 200 || !Array.isArray(mediaResponse.data.data)) throw new Error("读取媒体供应商失败，请重试配置");
    request.signal.throwIfAborted();
    if (!mediaResponse.data.data.some((provider) => provider.id === JinyuDream.id)) {
      await axios.post("/api/providers/media/add", { source: JinyuDreamSource }, { signal: request.signal });
    }
    request.signal.throwIfAborted();
    // ACT: 媒体文件已安装但保存失败时保留文件，重试通过列表复用，不覆盖用户编辑的模型。
    await saveSettings(settings => {
      request.signal.throwIfAborted();
      const providers = settings.customProviders ?? [];
      if (!Array.isArray(providers)) throw new Error("语言模型配置格式无效");
      const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
      if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
      const current = configs?.[JinyuDream.id];
      if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
      const index = providers.findIndex(provider => typeof provider?.id === "string" && provider.id.toLowerCase() === JinyuDream.id.toLowerCase());
      const previous = providers[index];
      const provider = {
        ...previous,
        id: previous?.id ?? JinyuDream.id,
        label: previous?.label ?? JinyuDream.label,
        apiUrl: JinyuDream.apiUrl,
        protocol: JinyuDream.protocol,
        apiKey,
        models: previous?.models ?? [],
      };
      return {
        customProviders: index < 0 ? [...providers, provider] : providers.map((item, position) => position === index ? provider : item),
        mediaProviderConfigs: { ...configs, [JinyuDream.id]: { ...current, apiKey } },
      };
    });
    invalidateNodeModels("media");
    if (request.signal.aborted) return;
    await hello.complete();
    anonymousData.track("onboarding.complete");
    loginKey.value = "";
    ElMessage.success("Linke API Key 已配置完成");
    await router.replace("/home");
  } catch (error) {
    if (!request.signal.aborted)
      loginError.value = axios.isAxiosError(error)
        ? error.response?.data?.message || "自动配置失败，请重试"
        : error instanceof Error
        ? error.message
        : "自动配置失败，请重试";
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  window.addEventListener("message", receiveLogin);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", receiveLogin);
  loginRequest?.abort();
  loginKey.value = "";
});
</script>

<style lang="scss" scoped>
.hello {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 100svh;
  padding: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-family: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;

  .pageLanguage {
    position: fixed;
    top: 16px;
    inset-inline-end: calc(50% + 8px);
    z-index: 2;
    max-width: calc(50% - 24px);
  }

  .welcomePanel {
    display: grid;
    grid-template-rows: 1fr auto 1fr;
    gap: 32px;
    min-width: 0;
    min-height: 544px;
    padding: 48px clamp(24px, 4.4vw, 64px);

    .providerContent {
      grid-row: 1;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 24px;
      min-width: 0;
      min-height: 0;
      overflow: hidden;

      .providerHeader {
        h1 {
          margin: 16px 0 0;
          font-size: 28px;
          font-weight: 650;
        }
      }

      .providerBody {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 2px;
      }

      .loginBody {
        min-height: 0;
        overflow-y: hidden;
        overscroll-behavior: contain;
        background-color: #fff;
        border-radius: var(--ui-radius);
        width: 500px;

        .loginFrame {
          display: block;
          width: 100%;
          height: 100%;
          min-height: 640px;
          border: 0;
          background: transparent;
        }
      }

      .loginFeedback {
        display: grid;
        gap: 12px;
      }
    }

    .welcomeContent {
      grid-row: 2;
      width: 100%;
      max-width: 420px;
      text-align: center;

      h1 {
        margin: 0 0 12px;
        font-size: clamp(32px, 3.4vw, 40px);
        font-weight: 650;
        line-height: 1.35;
        letter-spacing: -0.8px;
      }

      .description {
        margin: 0 0 32px;
        color: var(--el-text-color-secondary);
        font-size: 14px;
        line-height: 1.8;
      }

      .buttonIcon {
        width: 18px;
        height: 18px;
        margin-inline-end: 8px;
      }

      /* 首屏两个动作按钮：**同一规格** —— 宽/高/内边距/圆角/字号/字重完全一致，
         用上下顺序表达先后，而不是靠"一大一小"拉开差距。 */
      .actionButton {
        width: 100%;
        height: auto;
        min-height: 50px;
        margin: 0;
        padding: 12px;
        white-space: normal;
        border-radius: calc(var(--ui-radius) * 1.625);
        font-size: 16px;
        font-weight: 600;

        & + .actionButton {
          margin-top: 12px;
        }
      }

      .secondaryActions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin-top: 16px;

        .separator {
          color: var(--el-text-color-secondary);
          font-size: 13px;
        }

        .secondaryButton {
          height: auto;
          min-height: 36px;
          margin: 0;
          padding: 8px 16px;
          white-space: normal;
          font-size: 13px;
        }

        /* 「稍后配置」高亮 —— **配色照抄激活弹窗那颗「激活」按钮**
           （`scripts/launcher.cs` 的 LicenseForm：GradientFrom #7C5CF0 → GradientTo #E06CC8 + 白字）。
           用户口径：**只换颜色，尺寸/圆角/字号/字重一律不动** —— 所以这里只写颜色属性，
           其它全部继承 `.secondaryButton`。

           ⚠️ 必须 `!important`：`assets/main.scss` 里有一条**深色主题专用**规则
           `html.dark .el-button:not(.el-button--primary):not(…)…:hover`（特异性 0,8,1），
           会把悬停时的文字改成品牌前景色、边框改成中性灰。本组件 scoped 选择器最高只到
           0,8,0 —— 差一个类，压不过去；真压不过时，悬停会在紫渐变上冒出一圈灰边、
           白字也会变灰。 */
        .laterButton {
          color: #fff !important;
          border-color: transparent !important;
          background-image: linear-gradient(135deg, #7c5cf0, #e06cc8);

          /* 悬停/聚焦只把渐变提亮一档，保持同一配色语言。 */
          &:hover,
          &:focus-visible {
            background-image: linear-gradient(135deg, #8a6bf5, #e97ed2);
          }
        }
      }
    }

    .pageFooter {
      grid-row: 3;
      align-self: end;
      color: var(--el-text-color-secondary);
      font-size: 12px;

      p {
        margin: 10px 0 0;
        line-height: 1.6;
      }
    }
  }

  &.configuring {
    height: 100dvh;
    min-height: 0;
    overflow: hidden;

    .welcomePanel {
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 24px;
      min-height: 0;

      .pageFooter {
        grid-row: 2;
      }
    }
  }

  .artPanel {
    position: relative;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 28px;
    border-radius: calc(var(--ui-radius) * 1.125);
    overflow: hidden;
    background: radial-gradient(ellipse at 76% 82%, #f3dcb1 0%, transparent 46%), radial-gradient(ellipse at 25% 52%, #667ab5 0%, transparent 52%),
      radial-gradient(ellipse at 90% 18%, #369889 0%, transparent 48%), linear-gradient(145deg, #123f38, #467f72 48%, #a8c9ad);

    .artBg {
      z-index: 0;
    }

    .artBrand {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;

      .artLogo {
        width: 44px;
        height: 44px;
        line-height: 0;

        :deep(svg) {
          display: block;
          width: 100%;
          height: 100%;
        }

        :deep(path) {
          fill: #fff;
        }
      }

      .artName {
        font-size: 30px;
        font-weight: 600;
        letter-spacing: 0.4px;
      }
    }
  }

  /* 等待扫码遮罩：登录窗是独立的系统窗口，这里只负责说明 + 提供取消。
     用主题变量配色，浅色/深色主题都跟着走。 */
  .scanOverlay {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(0 0 0 / 45%);

    .scanCard {
      width: min(420px, 100%);
      padding: 28px 24px;
      text-align: center;
      border: 1px solid var(--el-border-color-lighter);
      border-radius: calc(var(--ui-radius) * 1.5);
      background: var(--el-bg-color);
      color: var(--el-text-color-primary);
      box-shadow: 0 18px 48px rgb(0 0 0 / 28%);

      h2 {
        margin: 18px 0 10px;
        font-size: 17px;
        font-weight: 650;
      }

      p {
        margin: 0 0 20px;
        color: var(--el-text-color-secondary);
        font-size: 13px;
        line-height: 1.8;
      }

      /* 「想一次加多个账号」的提示 —— 用弱底色块跟正文拉开层次 */
      .scanTip {
        margin-top: -8px;
        padding: 10px 12px;
        border-radius: var(--ui-radius);
        background: var(--el-fill-color-light);
        color: var(--el-text-color-regular);
        text-align: start;
      }

      .scanActions {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      }
    }

    .scanSpinner {
      display: inline-block;
      width: 34px;
      height: 34px;
      border: 3px solid var(--el-border-color);
      border-top-color: var(--el-color-primary);
      border-radius: 50%;
      animation: helloScanSpin 0.9s linear infinite;
    }
  }

  @media (max-width: 700px) {
    grid-template-columns: 1fr;

    .pageLanguage {
      inset-inline-end: 16px;
      max-width: calc(100% - 32px);
    }

    .welcomePanel {
      padding: 32px 20px;

      .welcomeContent {
        justify-self: center;
      }
    }

    .artPanel {
      display: none;
    }
  }
}

/* keyframes 必须放在选择器外面（放 .hello 里会编译出非法嵌套规则）。 */
@keyframes helloScanSpin {
  to {
    transform: rotate(360deg);
  }
}
</style>
