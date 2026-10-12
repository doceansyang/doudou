<template>
  <div class="tfAccount" :aria-busy="loading">
    <div v-if="apiKey" class="accountHeader">
      <div class="accountBalance">
        <el-text size="small" type="info">账户余额</el-text>
        <el-skeleton v-if="loading" animated>
          <template #template><el-skeleton-item class="balancePlaceholder" variant="text" /></template>
        </el-skeleton>
        <strong v-else-if="account?.ok" class="balanceNumber">{{ numberFormat.format(account.balance ?? 0) }}</strong>
        <el-text v-else class="balanceHint" size="small" type="info">{{ hint }}</el-text>
      </div>
      <div class="accountActions">
        <el-button text circle :icon="IconRefresh" :loading="loading" aria-label="刷新余额" title="刷新余额" @click="refresh" />
        <!--
          **余额只能靠网页登录的用户令牌读到**（sk key 读不到，见 apps/server/src/routes/linke.ts 的实测表）。
          `target="_blank"` 不是"弹新窗口"：启动器把 NewWindowRequested 接管成**原地导航**，
          于是会在软件窗口里打开、并显示「外部网页」返回条。登录/打开钱包页时，启动器注入到
          linke 页面的脚本会顺手把凭据回传给我们（不碰密码）；点「← 返回 JinyuTV」回来时
          整页重载，余额就显示出来了。
        -->
        <el-button v-if="!account?.ok" tag="a" href="https://api.linke.link/wallet" target="_blank" rel="noopener noreferrer" size="small" type="primary" :icon="IconLogin">登录并获取余额</el-button>
        <el-button v-else tag="a" href="https://api.linke.link/wallet" target="_blank" rel="noopener noreferrer" size="small" :icon="IconExternalLink">查看余额</el-button>
      </div>
    </div>
    <div v-if="!apiKey" class="accountSetup">
      <el-text size="small" type="info">填写API Key开始使用官方供应商</el-text>
      <div class="setupForm">
        <el-input
          v-model="draftKey"
          class="setupInput"
          type="password"
          dir="ltr"
          showPassword
          placeholder="粘贴 API Key"
          :disabled="saving"
          @keyup.enter="submitKey" />
        <el-button type="primary" size="small" :loading="saving" :disabled="!draftKey.trim()" @click="submitKey">保存</el-button>
      </div>
      <el-text v-if="setupError" size="small" type="danger">{{ setupError }}</el-text>
      <el-button tag="a" href="https://api.linke.link/" target="_blank" rel="noopener noreferrer" text type="primary" :icon="IconExternalLink">
        前往 Linke 官网 获取 API Key
      </el-button>
    </div>
    <div v-if="apiKey && account && !account.ok" class="accountNotice">
      <el-text size="small" type="info">
        linke 网关对 **API Key** 只开放「已用额度」，读不到余额；余额要用**网页登录的用户令牌**才能读（实测 `/api/user/self` 对 sk key 一律 401）。点「登录并获取余额」会在软件内打开网关的余额页 —— 登录一次即可，之后免登录。
      </el-text>
    </div>
    <div v-if="account?.ok" class="accountDetails">
      <div class="accountMetric">
        <el-text size="small" type="info">累计消费</el-text>
        <span>{{ numberFormat.format(account.used ?? 0) }}</span>
      </div>
      <div v-if="account.name" class="accountMetric">
        <el-text size="small" type="info">账号</el-text>
        <span>{{ account.name }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { locale } from "@toonflow/i18n/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import axios from "axios";
import { IconExternalLink, IconLogin, IconRefresh } from "@tabler/icons-vue";

/**
 * 余额来自**本国服务端** `/api/linke/balance`，不是直连网关。
 *
 * 为什么不直连：余额要用网页登录的用户令牌（sk key 读不到，实测 `/api/user/self` 一律 401），
 * 而令牌是启动器注入到 linke 页面里的脚本**回传**给服务端保存的 —— 浏览器这侧根本拿不到它，
 * 让它去直连只会多一份跨域与凭据的麻烦。判据与换算都在服务端一处（`routes/linke.ts`）。
 */
type LinkeAccount = { ok: boolean; reason?: "no-token" | "token-expired" | "failed"; balance?: number; used?: number; name?: string };

const props = withDefaults(defineProps<{
  apiKey: string;
  visible?: boolean;
  saveApiKey: (key: string) => Promise<void>;
}>(), { visible: true });
const apiKey = computed(() =>
  props.apiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim()
);
const account = ref<LinkeAccount>();
const loading = ref(false);
const draftKey = ref("");
const saving = ref(false);
const setupError = ref("");
const numberFormat = computed(() => new Intl.NumberFormat(locale.value, { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 6 }));
const hint = computed(() => {
  const reason = account.value?.reason;
  if (reason === "no-token") return "未登录（余额需网页登录令牌）";
  if (reason === "token-expired") return "登录已过期，请重新登录";
  if (reason === "failed") return "读取失败，可点左侧刷新重试";
  return "未获取到余额";
});
let controller: AbortController | undefined;

async function submitKey() {
  const key = draftKey.value.trim();
  if (!key || saving.value) return;
  saving.value = true;
  setupError.value = "";
  try {
    await props.saveApiKey(key);
    draftKey.value = "";
  } catch (error) {
    setupError.value = error instanceof Error ? error.message : "保存失败，请重试";
  } finally {
    saving.value = false;
  }
}

async function refresh() {
  controller?.abort();
  if (!apiKey.value || !props.visible) return;
  const request = new AbortController();
  controller = request;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: LinkeAccount }>("/api/linke/balance", {
      signal: request.signal,
      headers: { "x-toonflow-workspace": "1" },
      timeout: 30000,
    });
    if (request.signal.aborted) return;
    const payload = data?.data;
    account.value = payload && typeof payload === "object" ? payload : { ok: false, reason: "failed" };
  } catch {
    // 服务端读不到余额时**不会**抛错（它回 `{ok:false, reason}`），能走到这里只可能是网络/服务本身的问题。
    if (!request.signal.aborted) account.value = { ok: false, reason: "failed" };
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}

watch(
  [apiKey, () => props.visible],
  () => {
    account.value = undefined;
    draftKey.value = "";
    setupError.value = "";
    void refresh();
  },
  { immediate: true }
);
onBeforeUnmount(() => controller?.abort());
</script>

<style lang="scss" scoped>
.tfAccount {
  margin-top: 16px;
  padding: 14px;
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);

  .accountHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;

    .accountBalance {
      display: grid;
      justify-items: start;
      min-width: 0;
      gap: 4px;

      .balanceNumber {
        color: var(--el-text-color-primary);
        font-size: 24px;
        line-height: 1.3;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }

      .balancePlaceholder {
        width: 112px;
        height: 28px;
      }

      // 替代大号数字的那句说明：字号掉一档，避免"看起来像余额数字"
      .balanceHint {
        font-size: 13px;
        line-height: 1.3;
        color: var(--el-text-color-secondary);
      }
    }

    .accountActions {
      display: flex;
      align-items: center;
      gap: 6px;

      .el-button + .el-button {
        margin-left: 0;
      }
    }
  }

  .accountError {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    overflow-wrap: anywhere;
  }

  .accountNotice {
    margin-top: 12px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .accountSetup {
    display: grid;
    gap: 8px;
    margin-top: 12px;

    .setupForm {
      display: flex;
      gap: 8px;

      .setupInput {
        flex: 1;
        min-width: 0;
      }
    }
  }

  .accountDetails {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 12px 20px;
    margin-top: 16px;

    .accountMetric {
      display: grid;
      justify-items: start;
      min-width: 0;
      gap: 4px;
      color: var(--el-text-color-regular);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
  }
}
</style>
