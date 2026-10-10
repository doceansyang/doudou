<template>
  <el-dialog
    v-model="visible"
    :title="`编辑媒体供应商：${provider?.label ?? ''}`"
    width="min(800px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving">
    <div class="providerEditor">
      <!-- 生成账号绑定：豆包与 Dola 都按「账号」给每日免费额度，多绑几个即可自动换号 -->
      <div v-if="isDoubaoAccount" class="accountSection">
        <div class="accountHeader">
          <h4>账号绑定（豆包 / Dola） <el-text type="info">{{ doubaoAccounts.length }}</el-text></h4>
          <div class="accountHeaderActions">
            <el-select v-model="newAccountType" class="platformSelect" size="small" :disabled="accountBusy || saving" aria-label="新增账号的平台">
              <el-option v-for="item in platformOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button :icon="IconRefresh" size="small" :disabled="accountBusy" @click="loadAccounts">刷新</el-button>
            <el-button :icon="IconPlus" size="small" type="primary" :loading="accountBusy" :disabled="saving" @click="addAccount">绑定新账号（扫码）</el-button>
          </div>
        </div>
        <el-text class="accountHint" type="info">
          两个平台都按账号发放每日免费额度，各自独立计数。这里可以绑多个账号，生成时自动选用还有额度的那个；某个账号额度用尽会自动标记并换下一个。
        </el-text>
        <div v-if="accountsLoading" class="accountLoading">正在读取账号…</div>
        <template v-else>
          <el-card v-for="item in doubaoAccounts" :key="item.id" class="accountCard" shadow="never">
            <div class="accountRow">
              <div class="accountInfo">
                <span class="accountName">{{ item.name }}</span>
                <el-text type="info" size="small">今日已用 {{ item.usedToday }}/{{ item.dailyQuota }} · 剩余 {{ item.remaining }}</el-text>
              </div>
              <div class="accountActions">
                <el-tag size="small" effect="plain" :type="(item.accountType ?? 'doubao') === 'dola' ? 'warning' : 'info'">{{ item.platformLabel ?? "豆包" }}</el-tag>
                <el-tag v-if="item.exhausted" type="danger" size="small">今日额度已用完</el-tag>
                <el-tag v-else-if="item.busy" type="warning" size="small">生成中</el-tag>
                <el-tag v-else-if="!item.hasLoggedIn" type="info" size="small">未登录</el-tag>
                <el-tag v-else type="success" size="small">可用</el-tag>
                <el-button text size="small" :disabled="accountBusy" @click="loginAccount(item)">重新扫码</el-button>
                <el-button text size="small" type="danger" :disabled="accountBusy" @click="removeAccount(item)">删除</el-button>
              </div>
            </div>
          </el-card>
          <el-text v-if="!doubaoAccounts.length" type="info">还没有账号。先在上面选平台（豆包 / Dola 海外），再点「绑定新账号（扫码）」，在弹出的浏览器里登录即可。</el-text>
        </template>
        <el-alert v-if="accountError" class="accountError" :title="accountError" type="error" :closable="false" showIcon />
      </div>
      <messageMarkdown v-if="provider?.readme" class="providerReadme" :content="provider.readme" />
      <el-form labelPosition="top" :disabled="saving">
        <el-form-item label="API Key">
          <el-input v-model="apiKey" :prefixIcon="IconKey" type="password" dir="ltr" showPassword autocomplete="off" aria-label="媒体供应商 API Key" />
        </el-form-item>
      </el-form>

      <div class="modelHeader">
        <h4>模型配置 <el-text type="info">{{ models.length }}</el-text></h4>
        <el-button :icon="IconPlus" size="small" :disabled="saving" @click="editModel()">手动添加</el-button>
      </div>
      <div class="modelList">
        <el-card v-for="(item, index) in models" :key="index" class="modelCard" shadow="never">
          <div class="topInfo">
            <div class="modelNameWrap">
              <modelIcon :model="item.id" :size="24" />
              <div class="modelInfo">
                <span class="modelName">{{ item.label }}</span>
                <el-text class="modelId" type="info" size="small">{{ item.id }}</el-text>
              </div>
            </div>
            <div class="actionButtons">
              <el-button text size="small" :icon="IconEdit" :disabled="saving" :aria-label="`编辑模型 ${item.label}`" @click="editModel(index)">编辑</el-button>
              <el-button text size="small" type="danger" :icon="IconTrash" :disabled="saving" :aria-label="`删除模型 ${item.label}`" @click="models.splice(index, 1)">删除</el-button>
            </div>
          </div>
          <div class="modelTags">
            <el-tag size="small" type="info">{{ modelTypes[item.type] }}</el-tag>
            <el-tag v-for="(tag, tagIndex) in modelTags(item)" :key="tagIndex" size="small" type="info">{{ tag }}</el-tag>
          </div>
        </el-card>
        <el-text v-if="!models.length" type="info">暂无模型</el-text>
      </div>
    </div>
    <el-alert v-if="formError" class="formError" :title="formError" type="error" :closable="false" showIcon />
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :icon="IconDeviceFloppy" :loading="saving" @click="saveModels">保存</el-button>
    </template>
    <component
      :is="modelEditorDialog"
      v-model="modelEditorVisible"
      :model="editingModelIndex === undefined ? undefined : models[editingModelIndex]"
      :models="models"
      @confirmed="confirmModel" />
  </el-dialog>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";

import axios from "axios";
import { computed, defineAsyncComponent, ref, shallowRef, watch, type Component } from "vue";
import { IconPlus, IconTrash, IconDeviceFloppy, IconEdit, IconKey, IconRefresh } from "@tabler/icons-vue";
import { modelIcon } from "@toonflow/model-icons";
import messageMarkdown from "@/components/messageMarkdown.vue";
import type { MediaProvider, MediaProviderModel } from "./types";
import { settings, saveSettings } from "@/stores/settings";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";

const { provider } = defineProps<{ provider?: MediaProvider }>();
const modelEditorDialog = shallowRef<Component>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ saved: [provider: MediaProvider] }>();
const models = ref<MediaProviderModel[]>([]);
const modelEditorVisible = ref(false);
const editingModelIndex = ref<number>();
const saving = ref(false);
const apiKey = ref("");
const revision = ref("");
const formError = ref("");
// 生成账号管理（豆包 / Dola）：浏览器自动化跑在本地 RPA 服务里（不在沙箱内），故直接跨域调用它。
// 该服务已开 CORS，见 toonflow/scripts/doubao-rpa-service.ts。
const RPA_BASE = "http://127.0.0.1:18077";
const isDoubaoAccount = computed(() => provider?.id === "doubaoAccount");
const doubaoAccounts = ref<{ id: string; name: string; accountType?: string; platformLabel?: string; hasLoggedIn: boolean; usedToday: number; dailyQuota: number; remaining: number; exhausted: boolean; busy: boolean }[]>([]);
const accountsLoading = ref(false);
const accountBusy = ref(false);
const accountError = ref("");
// 新增账号时选平台：豆包（国内）与 Dola（海外）是两套独立站点与两套独立额度
const newAccountType = ref<"doubao" | "dola">("doubao");
const platformOptions = [
  { value: "doubao", label: "豆包（国内）" },
  { value: "dola", label: "Dola（海外）" },
];

async function loadAccounts() {
  if (!isDoubaoAccount.value) return;
  accountsLoading.value = true;
  accountError.value = "";
  try {
    const res = await fetch(`${RPA_BASE}/accounts`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    doubaoAccounts.value = Array.isArray(data?.accounts) ? data.accounts : [];
  } catch {
    accountError.value = `读不到账号列表：请先启动本地 RPA 服务（在 JinyuTV 目录执行 bun run scripts/doubao-rpa-service.ts）。`;
    doubaoAccounts.value = [];
  } finally {
    accountsLoading.value = false;
  }
}

/** 绑定新账号：服务端会打开对应平台的浏览器，用户扫码后自动登记。 */
async function addAccount() {
  accountBusy.value = true;
  accountError.value = "";
  try {
    const type = newAccountType.value;
    const label = type === "dola" ? "Dola 账号" : "豆包账号";
    const count = doubaoAccounts.value.filter(item => (item.accountType ?? "doubao") === type).length;
    const res = await fetch(`${RPA_BASE}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${label} ${count + 1}`, accountType: type }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    await loadAccounts();
  } catch (error) {
    accountError.value = `绑定失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    accountBusy.value = false;
  }
}

async function loginAccount(item: { id: string }) {
  accountBusy.value = true;
  accountError.value = "";
  try {
    const res = await fetch(`${RPA_BASE}/accounts/${encodeURIComponent(item.id)}/login`, { method: "POST" });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    await loadAccounts();
  } catch (error) {
    accountError.value = `登录失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    accountBusy.value = false;
  }
}

async function removeAccount(item: { id: string; name: string }) {
  accountBusy.value = true;
  accountError.value = "";
  try {
    await fetch(`${RPA_BASE}/accounts/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    await loadAccounts();
  } catch (error) {
    accountError.value = `删除失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    accountBusy.value = false;
  }
}

const modelTypes = { get image() { return translate("图片"); }, get video() { return translate("视频"); }, get audio() { return translate("音频"); }, get text() { return translate("文本"); } };
const modeLabels: Record<string, string> = {
  singleImage: "单图参考", multiReference: "多图参考", startEndRequired: "首尾帧必填",
  endFrameOptional: "尾帧可选", startFrameOptional: "首帧可选",
  imageReference: "图片参考", videoReference: "视频参考", audioReference: "音频参考",
};

watch(visible, isVisible => {
  if (!isVisible) return;
  formError.value = "";
  modelEditorVisible.value = false;
  editingModelIndex.value = undefined;
  const configs = settings.value.mediaProviderConfigs as Record<string, { apiKey?: unknown }> | undefined;
  const configuredKey = provider && configs?.[provider.id]?.apiKey;
  apiKey.value = typeof configuredKey === "string" ? configuredKey : "";
  revision.value = provider?.revision ?? "";
  models.value = JSON.parse(JSON.stringify(provider?.models ?? []));
  if (isDoubaoAccount.value) void loadAccounts();
}, { immediate: true });

function modelTags(model: MediaProviderModel) {
  const modes = Array.isArray(model.mode) ? model.mode.flat().filter((mode): mode is string => typeof mode === "string") : [];
  return modes.map(mode => {
    if (mode === "text") return model.type === "image" ? translate("文生图") : translate("文生视频");
    const reference = /^(imageReference|videoReference|audioReference):(\d+)$/.exec(mode);
    return reference ? `${modeLabels[reference[1]!]} ×${reference[2]}` : modeLabels[mode] ?? mode;
  });
}

function editModel(index?: number) {
  modelEditorDialog.value ??= defineAsyncComponent(() => import("./modelEditorDialog.vue"));
  editingModelIndex.value = index;
  modelEditorVisible.value = true;
}

function confirmModel(model: MediaProviderModel) {
  const index = editingModelIndex.value;
  if (index === undefined) models.value.push(model);
  else models.value.splice(index, 1, model);
}

async function saveModels() {
  if (saving.value || !provider) return;
  const { id: providerId, fileName } = provider;
  formError.value = "";
  let modelsSaved = false;
  let configSaved = false;
  try {
    const ids = new Set<string>();
    const values = models.value.map((item, index) => {
      const id = item.id.trim();
      const label = item.label.trim();
      if (!id || !label) throw new Error(`请填写第 ${index + 1} 个模型的 ID 和显示名称`);
      if (ids.has(id)) throw new Error(`模型 ID 重复：${id}`);
      ids.add(id);
      return { ...item, id, label };
    });
    if (apiKey.value.length > 8192) throw new Error("API Key 过长");
    saving.value = true;
    const nextKey = apiKey.value.trim();
    const { data } = await axios.put<{ code: number; data: MediaProvider; message?: string }>("/api/providers/media/save", {
      fileName, revision: revision.value, models: values,
    });
    if (data.code !== 200 || !data.data) throw new Error(data.message || "保存模型失败");
    revision.value = data.data.revision;
    modelsSaved = true;
    invalidateNodeModels("media");
    await saveSettings(settings => {
      const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
      if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
      const current = configs?.[providerId];
      if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
      if (nextKey === (current?.apiKey ?? "")) return;
      return { mediaProviderConfigs: { ...configs, [providerId]: { ...current, apiKey: nextKey } } };
    });
    configSaved = true;
    const response = await axios.get<{ code: number; data: MediaProvider[]; message?: string }>("/api/providers/media/list");
    if (response.data.code !== 200 || !Array.isArray(response.data.data)) throw new Error(response.data.message || "读取最新模型失败");
    const latest = response.data.data.find(item => item.fileName === fileName);
    if (!latest) throw new Error("供应商已不存在");
    revision.value = latest.revision;
    emit("saved", latest);
    visible.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "保存失败，请重试";
    formError.value = configSaved ? `模型与连接配置已保存，读取最新模型失败：${message}。请重新打开编辑。`
      : modelsSaved ? `模型已保存，连接配置未保存：${message}。填写内容已保留，请重试。` : message;
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.providerEditor {
  max-height: 65dvh;
  padding: 8px 4px;
  overflow-y: auto;
  overscroll-behavior: contain;

  .providerReadme { margin-bottom: 20px; }

  .modelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;

    h4 { margin: 0; }
  }

  .modelList {
    display: flex;
    flex-direction: column;
    gap: 10px;

    .modelCard {
      .topInfo {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;

        .modelNameWrap {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;

          .modelInfo {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
            overflow-wrap: anywhere;

            .modelName { font-size: 15px; font-weight: 600; }
            .modelId { align-self: flex-start; }
          }
        }

        .actionButtons {
          display: flex;
          flex-shrink: 0;
          margin-left: auto;
        }
      }

      .modelTags {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
    }
  }
}

.formError { margin-top: 16px; }

.accountSection {
  margin: 4px 0 20px;

  .accountHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;

    h4 { margin: 0; }
    .accountHeaderActions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }
    // 平台选择器：固定宽度，避免「豆包（国内）/ Dola（海外）」切换时按钮跟着位移
    .platformSelect { width: 132px; }
  }

  .accountHint { display: block; margin-bottom: 12px; line-height: 1.6; }
  .accountLoading { color: var(--el-text-color-secondary); font-size: 13px; }

  .accountCard {
    margin-bottom: 8px;

    .accountRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;

      .accountInfo {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        .accountName { font-weight: 600; }
      }

      .accountActions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    }
  }

  .accountError { margin-top: 10px; }
}
</style>
