<template>
  <!-- 收起态：一枚圆钮，与右上角的 Agent 圆钮左右对称。状态点 + 账号数一眼可见。 -->
  <el-tooltip v-if="collapsed" content="账号状态" placement="right" :showArrow="false" :hideAfter="0">
    <el-button
      class="dockButton"
      circle
      aria-controls="accountStatusPanel"
      :aria-expanded="false"
      aria-label="展开账号状态"
      @click="collapsed = false">
      <icon-users :size="17" aria-hidden="true" />
      <span class="dockBadge" :class="`is-${overallTone}`" aria-hidden="true">{{ accounts.length || "" }}</span>
    </el-button>
  </el-tooltip>

  <section v-else id="accountStatusPanel" class="accountPanel" role="region" aria-label="账号状态">
    <header class="panelHead">
      <span class="panelTitle">
        <icon-users :size="15" aria-hidden="true" />
        账号状态
      </span>
      <span class="panelTools">
        <el-button text circle size="small" :icon="IconRefresh" aria-label="刷新账号状态" title="刷新" @click="refresh()" />
        <el-button text circle size="small" :icon="IconChevronLeft" aria-label="收起账号状态" title="收起" @click="collapsed = true" />
      </span>
    </header>

    <p class="panelSummary" :class="`is-${overallTone}`">
      <span class="dot" aria-hidden="true" />
      <span v-if="accounts.length">可用 {{ usableCount }} · 额度用完 {{ exhaustedCount }} · 共 {{ accounts.length }}</span>
      <span v-else>还没有账号</span>
    </p>

    <p v-if="error" class="panelState is-error" role="status">{{ error }}</p>
    <p v-else-if="loading && !accounts.length" class="panelState" role="status">正在读取账号…</p>
    <p v-else-if="!accounts.length" class="panelState" role="status">还没有豆包账号，点下面的按钮登录一个。</p>
    <ul v-else class="accountList">
      <li v-for="item in accounts" :key="item.id" class="accountItem" :class="`is-${toneOf(item)}`">
        <span class="dot" aria-hidden="true" />
        <span class="itemBody">
          <span class="itemName" :title="item.name">{{ item.name }}</span>
          <span class="itemMeta">{{ metaOf(item) }}</span>
        </span>
        <span class="itemQuota" :title="quotaTitle(item)">
          <span class="quotaTrack"><span class="quotaFill" :style="{ width: `${quotaPercent(item)}%` }" /></span>
          <span class="quotaLabel">{{ item.exhausted ? "已用完" : `剩 ${item.remaining}` }}</span>
        </span>
      </li>
    </ul>

    <footer class="panelFoot">
      <el-button size="small" type="primary" plain :loading="adding" @click="addAccount">
        {{ adding ? "等待扫码登录…" : "添加账号（扫码）" }}
      </el-button>
      <span class="updated">{{ updatedText }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { IconChevronLeft, IconRefresh, IconUsers } from "@tabler/icons-vue";

/**
 * 画布左侧的「账号状态」浮窗。
 *
 * 数据来自本机豆包账号池服务（`<主服务自动拉起>`，127.0.0.1:18077）—— 与
 * 「媒体供应商 → 豆包账号」用的是同一个接口，口径一致：
 *   exhausted（今日额度用完）→ 红；busy（生成中）→ 琥珀；
 *   未登录 → 灰；其余 → 绿。
 * 只看状态，不做增删改账号这类重操作（那是设置里的事）。
 */

/** 账号池服务地址，与 hello 引导页 / 媒体供应商面板保持一致。 */
const RPA_URL = "http://127.0.0.1:18077";
/** 收起状态要记住 —— 用户把它藏起来，下次进画布不该又冒出来。 */
const COLLAPSE_KEY = "toonflow.accountStatusCollapsed";
/** 展开时勤一点，收起时只为了更新角标，慢一点省资源。 */
const POLL_OPEN_MS = 5000;
const POLL_CLOSED_MS = 20000;

type AccountRow = {
  id: string;
  name: string;
  accountType?: string;
  platformLabel?: string;
  hasLoggedIn: boolean;
  usedToday: number;
  dailyQuota: number;
  remaining: number;
  exhausted: boolean;
  busy: boolean;
};

const collapsed = ref(readCollapsed());
const accounts = ref<AccountRow[]>([]);
const loading = ref(false);
const adding = ref(false);
const error = ref("");
const updatedAt = ref<Date | null>(null);
/** 上一次请求是否失败过 —— 收起态角标要据此显示成"灰"。 */
const offline = ref(false);

const usableCount = computed(() => accounts.value.filter((item) => !item.exhausted && item.hasLoggedIn).length);
const exhaustedCount = computed(() => accounts.value.filter((item) => item.exhausted).length);
/** 角标取"最要紧的那一个"：离线 > 有号用完 > 生成中 > 未登录 > 全部可用。 */
const overallTone = computed(() => {
  if (error.value || offline.value) return "muted";
  if (!accounts.value.length) return "muted";
  if (exhaustedCount.value) return "danger";
  if (accounts.value.some((item) => item.busy)) return "warning";
  if (accounts.value.some((item) => !item.hasLoggedIn)) return "muted";
  return "success";
});
const updatedText = computed(() => (updatedAt.value ? `更新于 ${updatedAt.value.toLocaleTimeString("zh-CN", { hour12: false })}` : ""));

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function toneOf(item: AccountRow): string {
  if (item.exhausted) return "danger";
  if (!item.hasLoggedIn) return "muted";
  if (item.busy) return "warning";
  return "success";
}

function metaOf(item: AccountRow): string {
  const platform = item.platformLabel || (item.accountType === "dola" ? "Dola" : "豆包");
  if (item.exhausted) return `${platform} · 今日额度已用完`;
  if (!item.hasLoggedIn) return `${platform} · 未登录`;
  if (item.busy) return `${platform} · 生成中`;
  return `${platform} · 可用`;
}

function quotaPercent(item: AccountRow): number {
  if (item.exhausted) return 0;
  const total = Number(item.dailyQuota) || 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((item.remaining / total) * 100)));
}

function quotaTitle(item: AccountRow): string {
  return `今日已用 ${item.usedToday}/${item.dailyQuota}，剩余 ${item.remaining}`;
}

async function refresh(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    const response = await fetch(`${RPA_URL}/accounts`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    accounts.value = Array.isArray(data?.accounts) ? data.accounts : [];
    error.value = "";
    offline.value = false;
  } catch {
    offline.value = true;
    if (!quiet || !accounts.value.length) error.value = "读不到账号列表：本机账号服务未在运行。";
  } finally {
    updatedAt.value = new Date();
    loading.value = false;
  }
}

/**
 * 添加账号：服务端会打开豆包登录窗口，用户扫码后自动登记。
 *
 * 这是个**长请求**（窗口一直开着，最长 10 分钟），所以不等它、也不做遮罩；
 * 轮询会第一时间把新账号显示出来。请求结束时（登录完成 / 取消 / 超时）再复位按钮。
 */
async function addAccount() {
  if (adding.value) return;
  adding.value = true;
  error.value = "";
  fetch(`${RPA_URL}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountType: "doubao" }),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!data?.ok) error.value = `添加失败：${data?.error || `HTTP ${response.status}`}`;
    })
    .catch(() => { error.value = "添加失败：连不上本机账号服务。"; })
    .finally(() => { adding.value = false; void refresh(true); });
}

let timer: number | undefined;
function startPolling() {
  stopPolling();
  timer = window.setInterval(() => void refresh(true), collapsed.value ? POLL_CLOSED_MS : POLL_OPEN_MS);
}
function stopPolling() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

watch(collapsed, (value) => {
  try { localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0"); } catch { /* 无痕模式忽略 */ }
  startPolling();
  // 展开时立刻拉一次，别让用户对着旧数据等一轮轮询。
  if (!value) void refresh(true);
});

onMounted(() => {
  void refresh(collapsed.value);
  startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<style scoped lang="scss">
/* 位置与 workspaceMenu 对齐（left 15px），垂直居中；层级与画布其它浮层一致（z-index 5）。 */
.dockButton {
  position: absolute;
  top: 50%;
  left: 15px;
  z-index: 5;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--el-border-color-light);
  border-radius: 50%;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-lighter);
  transform: translateY(-50%);
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;

  &:hover {
    transform: translateY(calc(-50% - 1px));
    border-color: var(--el-border-color);
    box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
  }

  &:active {
    transform: translateY(-50%) scale(0.95);
  }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 3px;
  }

  /* 角标：账号数 + 总体状态色 */
  .dockBadge {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 999px;
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--el-bg-color-overlay);

    &.is-success { background: var(--el-color-success); }
    &.is-warning { background: var(--el-color-warning); }
    &.is-danger { background: var(--el-color-danger); }
    &.is-muted { background: var(--el-text-color-disabled); }
  }
}

.accountPanel {
  position: absolute;
  top: 50%;
  left: 15px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: 264px;
  max-height: min(64vh, 520px);
  padding: 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius-large, 12px);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);
  transform: translateY(-50%);

  .panelHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--el-border-color-lighter);

    .panelTitle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--el-text-color-primary);
      font-size: 13px;
      font-weight: 600;
    }

    .panelTools {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-inline-end: -4px;
    }
  }

  .panelSummary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  /* 状态点：绿=可用、红=额度用完、琥珀=生成中、灰=未登录/离线 */
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--el-text-color-disabled);
  }

  .is-success .dot { background: var(--el-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-success) 18%, transparent); }
  .is-warning .dot { background: var(--el-color-warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-warning) 18%, transparent); }
  .is-danger .dot { background: var(--el-color-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-danger) 18%, transparent); }
  .is-muted .dot { background: var(--el-text-color-disabled); }

  .panelState {
    margin: 0;
    padding: 10px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.7;

    &.is-error { color: var(--el-color-danger); }
  }

  .accountList {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  .accountItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: var(--ui-radius, 8px);
    transition: background-color 150ms ease;

    & + .accountItem { margin-top: 2px; }
    &:hover { background: var(--el-fill-color-light); }

    .itemBody {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
      line-height: 1.35;
    }

    .itemName {
      overflow: hidden;
      color: var(--el-text-color-primary);
      font-size: 12.5px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .itemMeta {
      overflow: hidden;
      color: var(--el-text-color-secondary);
      font-size: 11px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    /* 额度：细进度条 + 剩余数。红/灰状态下条子也一起变色，扫一眼就知道哪个号不能用了。 */
    .itemQuota {
      display: flex;
      flex: none;
      flex-direction: column;
      align-items: flex-end;
      gap: 3px;
      width: 56px;
    }

    .quotaTrack {
      width: 100%;
      height: 4px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--el-fill-color-dark);
    }

    .quotaFill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--el-color-success);
      transition: width 240ms ease;
    }

    .quotaLabel {
      color: var(--el-text-color-secondary);
      font-size: 10.5px;
      white-space: nowrap;
    }

    &.is-danger {
      .itemName, .quotaLabel { color: var(--el-color-danger); }
      .quotaFill { background: var(--el-color-danger); }
    }

    &.is-warning {
      .quotaFill { background: var(--el-color-warning); }
    }

    &.is-muted {
      .itemName { color: var(--el-text-color-secondary); }
      .quotaFill { background: var(--el-text-color-disabled); }
    }
  }

  .panelFoot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--el-border-color-lighter);

    .updated {
      color: var(--el-text-color-secondary);
      font-size: 11px;
      white-space: nowrap;
    }
  }
}
</style>
