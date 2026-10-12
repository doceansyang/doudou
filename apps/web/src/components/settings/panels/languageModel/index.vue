<template>
  <div class="providerList">
    <div class="itemList">
      <el-card v-for="item in sortedProviders" :key="item.id" class="providerItem" shadow="never">
        <div class="providerHeader">
          <div v-if="isJinyuDreamProvider(item)" class="providerMark" aria-hidden="true">
            <img class="providerLogo" :src="logoUrl" alt="" />
          </div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ item.label }}</el-text>
              <el-tag v-if="isJinyuDreamProvider(item)" size="small" type="info">官方</el-tag>
            </div>
            <el-text class="providerId" size="small" type="info" :title="item.id">{{ item.id }}</el-text>
          </div>
        </div>
        <tfAccount v-if="isJinyuDreamProvider(item)" :apiKey="typeof item.apiKey === 'string' ? item.apiKey : ''" :visible="visible" :saveApiKey="(key) => saveProviderApiKey(item.id, key)" />
        <div class="providerFooter">
          <div class="providerMeta">
            <el-tag v-if="getProviderVersion(item)" size="small" type="info" effect="plain">v{{ getProviderVersion(item) }}</el-tag>
            <el-text size="small" type="info">{{ item.models.length }} 个模型</el-text>
          </div>
          <el-space class="itemActions" wrap>
            <!-- 「获取模型」与媒体模型那侧对齐：**常驻**在这一排里（原先只在
                 「官方 + 已填 key + 模型列表为空」时才冒出来，用户根本找不到）。
                 ⚠️ 只按「是不是官方平台」判断，不再看 key 与模型数量 —— 没填 key 时
                 由接口给出可操作的提示（"请先填写 API 密钥，再获取模型列表"），
                 比给一个灰按钮不解释要好。 -->
            <el-button v-if="isJinyuDreamProvider(item)" text :icon="IconRefresh" :loading="fetchingId === item.id" :disabled="!!deletingId || !!fetchingId" @click="fetchProviderModels(item)">获取模型</el-button>
            <el-button text :icon="IconEdit" :disabled="!!deletingId" @click="openCustomProvider(item)">编辑</el-button>
            <el-popconfirm title="确定删除此供应商及其模型？" confirmButtonText="删除" cancelButtonText="取消" @confirm="deleteProvider(item.id)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="deletingId === item.id" :disabled="!!deletingId">删除</el-button></template>
            </el-popconfirm>
          </el-space>
        </div>
      </el-card>
    </div>
    <component :is="addCustomProviderDialog" v-model="customProviderDialogVisible" :provider="editingProvider" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, type Component } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { customProviders, saveSettings, type CustomProvider } from "@/stores/settings";
import { IconEdit, IconTrash, IconRefresh } from "@tabler/icons-vue";
import { languageProviders } from "@toonflow/providers";
import logoUrl from "@toonflow/assets/logo.svg";
import tfAccount from "../../tfAccount.vue";
import { isJinyuDreamProvider } from "@/lib/tf";

const { visible = true } = defineProps<{ visible?: boolean }>();
// ⚠️ 「添加供应商」「添加自定义供应商」两个入口已按要求**整体移除**（本软件只接官方
//   中转平台 Linke，不让用户自己加别的中转站）。因此 `addProviderDialog` /
//   `openProvider` 也一并删掉了 —— 留着一个再也点不到的弹窗只会让下一个人以为还有入口。
//   `addCustomProviderDialog` **必须保留**：它同时是「编辑」按钮用的那个弹窗。
const addCustomProviderDialog = shallowRef<Component>();
const customProviderDialogVisible = ref(false);
const editingProvider = ref<CustomProvider>();
const deletingId = ref("");
const fetchingId = ref("");
const sortedProviders = computed(() => [...customProviders.value].sort((a, b) => Number(isJinyuDreamProvider(b)) - Number(isJinyuDreamProvider(a))));

function getProviderVersion(provider: CustomProvider) {
  const version = languageProviders.find(item => item.id.toLowerCase() === provider.id.toLowerCase())?.version ?? provider.version;
  return typeof version === "string" ? version.trim() : "";
}

function openCustomProvider(provider?: CustomProvider) {
  addCustomProviderDialog.value ??= defineAsyncComponent(() => import("./addCustomProviderDialog.vue"));
  editingProvider.value = provider;
  customProviderDialogVisible.value = true;
}

async function deleteProvider(id: string) {
  if (deletingId.value) return;
  deletingId.value = id;
  try {
    await saveSettings(settings => {
      const current = settings.customProviders;
      if (!Array.isArray(current)) throw new Error("配置格式错误");
      return { customProviders: current.filter(item => item?.id !== id) };
    });
  } catch { ElMessage.error("删除失败，请重试"); }
  finally { deletingId.value = ""; }
}

async function saveProviderApiKey(id: string, key: string) {
  const provider = customProviders.value.find(item => item.id === id);
  if (!provider) throw new Error("供应商已不存在");
  const { apiUrl, protocol, apiKey } = provider;
  await saveSettings(settings => {
    const current = settings.customProviders;
    if (!Array.isArray(current)) throw new Error("配置格式错误");
    const latest = current.find(item => item?.id === id);
    if (!latest) throw new Error("供应商已不存在");
    if (latest.apiUrl !== apiUrl || latest.protocol !== protocol || latest.apiKey !== apiKey) {
      throw new Error("供应商配置已变更，请重试");
    }
    return { customProviders: current.map(item => item?.id === id ? { ...item, apiKey: key } : item) };
  });
}

async function fetchProviderModels(provider: CustomProvider) {
  if (fetchingId.value) return;
  const { id, apiUrl, protocol, apiKey } = provider;
  fetchingId.value = id;
  try {
    const { data } = await axios.post("/api/providers/models", { apiUrl, protocol, apiKey }, { timeout: 35000 });
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "获取模型列表失败");
    // ⚠️ 文案要说「**文本**模型」：接口默认会把媒体模型（seedance / wan3.0 / gpt-image-2 …）
    //    剔掉，而网关那边它们是和文本模型混在同一个列表里的 —— 说清楚才不会被误当成"漏了"。
    if (!data.data.length) throw new Error("未获取到可用的文本模型，请检查 API Key 后重试");
    await saveSettings(settings => {
      const current = settings.customProviders;
      if (!Array.isArray(current)) throw new Error("配置格式错误");
      const latest = current.find(item => item?.id === id);
      if (!latest) throw new Error("供应商已不存在");
      if (latest.apiUrl !== apiUrl || latest.protocol !== protocol || latest.apiKey !== apiKey) {
        throw new Error("供应商配置已变更，请重试");
      }
      return { customProviders: current.map(item => item?.id === id ? { ...item, models: data.data } : item) };
    });
    ElMessage.success(`已更新 ${data.data.length} 个文本模型`);
  } catch (error) {
    ElMessage.error(axios.isAxiosError(error) ? error.response?.data?.message || "获取模型列表失败，请重试" : error instanceof Error ? error.message : "获取模型列表失败，请重试");
  }
  finally { fetchingId.value = ""; }
}
</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
