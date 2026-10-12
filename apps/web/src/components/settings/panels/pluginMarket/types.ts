import type { Rule } from "@form-create/element-ui";
import type { Raw } from "vue";

export type PluginType = "node" | "skill" | "tool" | "agent" | "ext";

export interface Plugin {
  key: string;
  id?: number;
  isCollected?: boolean;
  type: PluginType;
  name: string;
  displayName: string;
  author?: string;
  description?: string;
  readme?: string;
  github?: string;
  version?: string;
  enabled?: boolean;
  canConfigure?: boolean;
  canManage?: boolean;
  configRules?: Raw<Rule[]>;
  config?: Record<string, unknown>;
  url?: string;
  fileName?: string;
  kind?: "local" | "remote";
  cardUrl?: string;
  loadError?: string;
  /**
   * 这个已安装插件是从市场哪个 identifier 装来的（安装时由服务端落下 `.toonflowMarket.json`）。
   * 市场的 identifier 和技能自报的名字经常不是同一个：后者以上游包里的 name 为准，
   * 所以「装没装」不能只看 identifier —— 没有这条来源记录，装好了也一直显示「安装」。
   */
  marketIdentifier?: string;
}
