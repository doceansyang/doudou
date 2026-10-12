<template>
  <div class="tfAccount" :aria-busy="loading">
    <div v-if="apiKey" class="accountHeader">
      <div class="accountBalance">
        <el-text size="small" type="info">账户余额</el-text>
        <el-skeleton v-if="loading && !balance && !unsupported" animated>
          <template #template><el-skeleton-item class="balancePlaceholder" variant="text" /></template>
        </el-skeleton>
        <strong v-else-if="balance" class="balanceNumber">{{ numberFormat.format(balance.balance) }}</strong>
        <!-- 网关上没有余额接口时，别把 axios 的 "Request failed with status code 404"
             原样抖给用户 —— 那看着像"我的 key 填错了"。这里给一句人话。 -->
        <el-text v-else-if="unsupported" class="balanceHint" size="small" type="info">网关未提供此接口</el-text>
        <strong v-else class="balanceNumber">—</strong>
      </div>
      <div class="accountActions">
        <el-button text circle :icon="IconRefresh" :loading="loading" :disabled="!apiKey" aria-label="刷新余额" title="刷新余额" @click="refresh" />
        <el-button v-if="!unsupported" size="small" :icon="IconCreditCard" :disabled="!apiKey" @click="openRecharge">充值</el-button>
        <!--
          直达网关的**真实余额页** /wallet（实测：它会 302 到
          `https://api.linke.link/sign-in?redirect=%2Fwallet`，即"需登录的真实路由"；
          而那个 SPA 对任意路径都返回同一份 200 HTML，所以光看状态码判别不了）。
          `target="_blank"` 不是"弹新窗口"：启动器把 NewWindowRequested 接管成
          **原地导航**，于是会在软件窗口里打开、并显示「外部网页」返回条
          （Alt+← 或点「← 返回 JinyuTV」回到软件）。登录一次后 cookie 常驻。
        -->
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
    <div v-else-if="unsupported" class="accountNotice">
      <el-text size="small" type="info">
        当前网关（api.linke.link）不提供「密钥余额」接口，所以这里读不到数字。点右侧「查看余额」会在软件内打开网关的余额页（首次需登录，之后免登录）。
      </el-text>
    </div>
    <div v-else-if="errorMessage" class="accountError" role="alert">
      <el-text size="small" type="danger">{{ errorMessage }}</el-text>
      <el-button text size="small" :disabled="loading" @click="refresh">重试</el-button>
    </div>
    <div v-if="balance" class="accountDetails">
      <div class="accountMetric">
        <el-text size="small" type="info">密钥余额</el-text>
        <span>{{ balance.keyBalance === null ? "无限制" : numberFormat.format(balance.keyBalance) }}</span>
      </div>
      <div class="accountMetric">
        <el-text size="small" type="info">累计消费</el-text>
        <span>{{ numberFormat.format(balance.totalConsumption) }}</span>
      </div>
      <div class="accountMetric">
        <el-text size="small" type="info">累计充值</el-text>
        <span>{{ numberFormat.format(balance.totalRecharge) }}</span>
      </div>
    </div>
    <component :is="rechargeDialog" v-model="rechargeVisible" :apiKey="apiKey" />
  </div>
</template>

<script setup lang="ts">
import { locale } from "@toonflow/i18n/vue";
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch, type Component } from "vue";
import axios from "axios";
import { IconCreditCard, IconExternalLink, IconRefresh } from "@tabler/icons-vue";
import tf, { type TfBalance } from "@/lib/tf";

const props = withDefaults(defineProps<{
  apiKey: string;
  visible?: boolean;
  saveApiKey: (key: string) => Promise<void>;
}>(), { visible: true });
const rechargeDialog = shallowRef<Component>();
const rechargeVisible = ref(false);
const apiKey = computed(() =>
  props.apiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim()
);
const balance = ref<TfBalance>();
const loading = ref(false);
const errorMessage = ref("");
/**
 * 网关上根本没有余额接口（HTTP 404）。
 *
 * 背景：这套「余额 / 充值」接口（`/v1/balance`、`/v1/recharge/*`、`/web/*`）是
 * **原版 Toonflow 私有后端**的；当初做品牌替换时是把域名整串替换过去的
 * （见 `scripts/rebrand-api-to-linke.py`），而 api.linke.link 是个 **new-api 网关**，
 * 只有 OpenAI 兼容的 `/v1/*` 与它自己的 `/api/*`，没有这些路由 —— 实测：
 *   `GET /v1/models` -> 200（key 有效）
 *   `GET /v1/balance` -> 404 Invalid URL
 *   `/v1/dashboard/billing/*` -> 200 但值是**写死的占位**（hard_limit 1e8）
 *   `/api/user/*` -> 401（要网页登录态，不认 sk key）
 * 所以这里不再把 axios 的 404 原文抛给用户（看着像"key 填错了"），
 * 改成明说"网关没这个接口"+ 给控制台入口；一旦换回支持该接口的网关，原逻辑自动恢复。
 */
const unsupported = ref(false);
const draftKey = ref("");
const saving = ref(false);
const setupError = ref("");
const numberFormat = computed(() => new Intl.NumberFormat(locale.value, { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 6 }));
let controller: AbortController | undefined;
let rechargeKey = "";

function openRecharge() {
  if (!apiKey.value || !props.visible) return;
  rechargeKey = apiKey.value;
  rechargeDialog.value ??= defineAsyncComponent(() => import("./tfRechargeDialog.vue"));
  rechargeVisible.value = true;
}

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
  loading.value = false;
  errorMessage.value = "";
  unsupported.value = false;
  if (!apiKey.value || !props.visible) return;
  const request = new AbortController();
  controller = request;
  loading.value = true;
  try {
    const result = await tf.getBalance({ apiKey: apiKey.value, signal: request.signal });
    if (!request.signal.aborted) balance.value = result;
  } catch (error) {
    if (!request.signal.aborted) {
      // 404 = 这个网关上没有该路由，不是"你的 key 有问题"，所以走专门的提示分支
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) {
        unsupported.value = true;
      } else {
        errorMessage.value = axios.isAxiosError<{ message?: string }>(error)
          ? error.response?.data?.message || error.message
          : error instanceof Error
          ? error.message
          : "余额查询失败，请重试";
      }
    }
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}

watch(
  [apiKey, () => props.visible],
  () => {
    rechargeVisible.value = false;
    balance.value = undefined;
    draftKey.value = "";
    setupError.value = "";
    void refresh();
  },
  { immediate: true }
);
watch(rechargeVisible, (isOpen, wasOpen) => {
  if (wasOpen && !isOpen && rechargeKey === apiKey.value && props.visible) void refresh();
});
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
