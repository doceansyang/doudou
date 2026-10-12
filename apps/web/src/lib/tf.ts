import axios from "axios";
import { customProviders, settings } from "@/stores/settings";

type TfRequestOptions = { apiKey?: string; signal?: AbortSignal };

export type TfBalance = {
  balance: number;
  totalConsumption: number;
  totalRecharge: number;
  keyBalance: number | null;
};

export type TfPayment = { orderNumber: string; payUrl?: string };
type TfOrder = { orderNumber: string; status: string | number };
export type TfRechargeSku = { id: number; price: number; integral: number; describe: string };
export type TfSponsor = { id: number; name: string; logoUrl: string; readme: string };
type TfResponse<T> = { code: number; data: T; message?: string };

export type TfPayParams = {
  comboId: number;
  customMoney?: number;
  payType: "wechat" | "alipay";
};

type TfPlugin = {
  id: number;
  name: string;
  identifier: string;
  userId: number;
  supplier: string;
  type: "node" | "skill" | "tool" | "agent" | "ext";
  state: number;
  desc: string;
  link: string;
  fileName: string;
  creationTime: number;
  installation: number;
  download: number;
  version: string;
  updateById: number | null;
  isCollected: boolean;
};

type TfPluginParams = {
  page: number;
  limit: number;
  type: "all" | "node" | "skill" | "tool" | "agent" | "ext" | "my" | "collection";
  searchKeyword?: string;
};

export function isJinyuDreamProvider(provider: { id: string; apiUrl: string }) {
  // 注意 provider.id 已由 tfRouter 改名为 JinyuDream，这里比较的是**小写形式**，
  // 所以字面量必须写全小写的 "jinyudream"（历史上这里漏改过，导致识别恒为 false、
  // 取不到 API Key、关于页报「Linke 响应格式不正确」）。
  return provider.id.toLowerCase() === "jinyudream" && URL.canParse(provider.apiUrl)
    && new URL(provider.apiUrl).origin === "https://api.linke.link";
}

const client = axios.create({ baseURL: "https://api.linke.link" });

/**
 * 插件市场走的是**我们自己的中转服务**（`https://linke.link/v1/plugin/*`）。
 *
 * ## 为什么不是直连 Toonflow
 * 市场接口原本是 Toonflow 的私有后端（`api.toonflow.net/v1/plugin/*`），要一把 Toonflow 的 key。
 * 把 key 塞进客户端等于把凭据发给每个用户（扒出来就能用、泄漏了只能靠发新版收回）。
 * 所以 key 只留在服务端（`/etc/plugin-forwarder.env`，权限 600），客户端只见我们自己的域名。
 *
 * ## 中转都做了什么
 * ① 接口形状与 Toonflow **完全一致**，客户端不用改任何解析逻辑；
 * ② 列表里的下载链接改写成走中转（`?d=<加密令牌>`），连上游存储域名都不出现在流量里；
 * ③ 上游的报错**只进服务端日志**，回给客户端的只是「插件服务暂时不可用」
 *    （Toonflow 的措辞和状态码一个都不外泄）；
 * ④ 只放行 `/v1/plugin/*` 两个路由 + 上游存储的 `/plugins/` 资源，不是个开放代理。
 *
 * ## ⚠️ 客户端不再需要、也不该再要求市场 key
 * 见 marketRequestOptions：没 key 也能正常浏览市场；用户旧设置里若还留着，带上也无害（中转忽略）。
 */
export const PLUGIN_MARKET_BASE_URL = "https://linke.link";
const marketClient = axios.create({ baseURL: PLUGIN_MARKET_BASE_URL });

/**
 * 早先直连 Toonflow 时用户填的市场 key。
 * 现在 key 在服务端，这个值只用于「万一要退回直连」的兜底读取，**不是必需品**。
 */
export function getPluginMarketApiKey() {
  const value = (settings.value as Record<string, unknown>).pluginMarketApiKey;
  return typeof value === "string" ? value.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
}

export function getTfApiKey() {
  const provider = customProviders.value.find(isJinyuDreamProvider);
  const mediaConfigs = settings.value.mediaProviderConfigs as Record<string, { apiKey?: unknown }> | undefined;
  return [provider?.apiKey, mediaConfigs?.JinyuDream?.apiKey]
    .map(key => typeof key === "string" ? key.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "")
    .find(Boolean) ?? "";
}

function requestOptions({ apiKey, signal }: TfRequestOptions = {}) {
  const key = (apiKey ?? getTfApiKey()).trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!key) throw new Error("请先配置 Linke API Key");
  return { signal, timeout: 20000, headers: { Authorization: `Bearer ${key}` } };
}

/**
 * 市场请求的选项：**不要求**客户端持有 key —— 凭据在中转服务里（见 PLUGIN_MARKET_BASE_URL）。
 * 用户旧设置里若还留着 `pluginMarketApiKey` 就一并带上，中转会忽略它，不影响结果。
 */
function marketRequestOptions({ apiKey, signal }: TfRequestOptions = {}) {
  const key = (apiKey ?? getPluginMarketApiKey()).trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  return { signal, timeout: 20000, headers: key ? { Authorization: `Bearer ${key}` } : {} };
}

function responseData<T>(response: TfResponse<T>, fallback = "Linke 请求失败"): T {
  if (!response || typeof response !== "object" || typeof response.code !== "number") throw new Error("Linke 响应格式不正确");
  if (response.code !== 200) throw new Error(response.message || fallback);
  return response.data;
}

function balanceAmount(value: unknown): number {
  const amount = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new Error("余额响应格式不正确");
  return amount;
}

export default {
  async getSponsorList(options?: Pick<TfRequestOptions, "signal">): Promise<TfSponsor[]> {
    const { data } = await client.post<TfResponse<TfSponsor[]>>("/web/sponsor/getSponsorList", null, { signal: options?.signal, timeout: 20000 });
    const sponsors = responseData(data, "加载赞助商失败");
    if (!Array.isArray(sponsors) || sponsors.some(item => !item || !Number.isSafeInteger(item.id) || item.id < 1
      || typeof item.name !== "string" || typeof item.logoUrl !== "string" || typeof item.readme !== "string")) throw new Error("赞助商响应格式不正确");
    return sponsors;
  },

  async queryOrder(orderNumber: string, options?: TfRequestOptions): Promise<TfOrder> {
    if (!orderNumber.trim()) throw new Error("订单号不能为空");
    const { data } = await client.get<TfResponse<TfOrder>>("/v1/recharge/queryOrder", { ...requestOptions(options), params: { orderNumber: orderNumber.trim() } });
    const order = responseData(data);
    if (!order || order.orderNumber !== orderNumber.trim() || !["string", "number"].includes(typeof order.status)) throw new Error("订单查询响应格式不正确");
    return order;
  },

  async getRechargeData(options?: TfRequestOptions): Promise<TfRechargeSku[]> {
    const { data } = await client.get<TfResponse<unknown>>("/v1/recharge/getRechargeData", requestOptions(options));
    const skus = responseData(data);
    if (!Array.isArray(skus)) throw new Error("充值套餐响应格式不正确");
    return skus.map(sku => {
      const price = typeof sku?.price === "string" && sku.price.trim() ? Number(sku.price) : sku?.price;
      const integral = typeof sku?.integral === "string" && sku.integral.trim() ? Number(sku.integral) : sku?.integral;
      if (!sku || !Number.isSafeInteger(sku.id) || sku.id < 1 || typeof price !== "number" || !Number.isFinite(price) || price <= 0
        || typeof integral !== "number" || !Number.isFinite(integral) || integral < 0 || typeof sku.describe !== "string") throw new Error("充值套餐响应格式不正确");
      return { id: sku.id, price, integral, describe: sku.describe };
    });
  },

  async getBalance(options?: TfRequestOptions): Promise<TfBalance> {
    const { data } = await client.get<TfResponse<TfBalance>>("/v1/balance", requestOptions(options));
    const balance = responseData(data);
    return {
      balance: balanceAmount(balance?.balance),
      totalConsumption: balanceAmount(balance?.totalConsumption),
      totalRecharge: balanceAmount(balance?.totalRecharge),
      keyBalance: balance?.keyBalance === null ? null : balanceAmount(balance?.keyBalance),
    };
  },

  async pay({ comboId, customMoney, payType }: TfPayParams, options?: TfRequestOptions): Promise<TfPayment> {
    if (!Number.isSafeInteger(comboId) || (comboId !== -1 && comboId < 1)) throw new Error("充值套餐 ID 必须为正整数或 -1");
    if (payType !== "wechat" && payType !== "alipay") throw new Error("请选择微信或支付宝支付");
    if (comboId === -1 && (typeof customMoney !== "number" || !Number.isFinite(customMoney) || customMoney < 0.01 || customMoney > 50000)) {
      throw new Error("自定义充值金额必须在 0.01 至 50000 之间");
    }
    const { data } = await client.post<TfResponse<TfPayment>>("/v1/recharge/pay", {
      comboId,
      ...(comboId === -1 ? { customMoney } : {}),
      payType,
    }, requestOptions(options));
    const payment = responseData(data);
    if (!payment || typeof payment.orderNumber !== "string" || !payment.orderNumber.trim()
      || (payment.payUrl !== undefined && typeof payment.payUrl !== "string")) throw new Error("支付响应格式不正确");
    return payment;
  },

  async getPlugIn(params: TfPluginParams, options?: TfRequestOptions) {
    if (!Number.isSafeInteger(params.page) || params.page < 1) throw new Error("页码必须为正整数");
    if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) throw new Error("每页数量必须为 1 至 50 的整数");
    // ⚠️ 走 marketClient（toonflow），不是 Linke —— 见 PLUGIN_MARKET_BASE_URL 的说明。
    const { data } = await marketClient.post<TfResponse<{ list: TfPlugin[]; total: number }>>("/v1/plugin/getPlugin", params, marketRequestOptions(options));
    return responseData(data, "加载插件市场失败");
  },

  async toggleCollection(pluginId: number, options?: TfRequestOptions): Promise<{ collected: boolean }> {
    if (!Number.isSafeInteger(pluginId) || pluginId < 1) throw new Error("插件 ID 必须为正整数");
    const { data } = await marketClient.post<TfResponse<{ collected: boolean }>>("/v1/plugin/toggleCollection", { pluginId }, marketRequestOptions(options));
    const collection = responseData(data, "更新插件收藏失败");
    if (typeof collection?.collected !== "boolean") throw new Error("插件收藏响应格式不正确");
    return collection;
  },
};
