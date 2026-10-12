import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      // 用户要求（2026-10-12）：**打开软件就停在这一页**（即使已经完成过引导）。
      // ⚠️ 别恢复成「已完成引导就 `replace` 到 /home」——那会让这一页永远看不到，
      //    而被改掉正是这一次的需求本身。要回首页点「稍后配置」或登录完成即可。
      //
      // `load()` 仍然要调：它负责旧版 localStorage 标记的迁移（已经配置过模型时把
      // helloCompleted 补成 true）。漏掉这段，会让「开发者选项 → 重置引导」里的状态与真实情况对不上。
      beforeEnter: async () => { await useHelloStore().load(); return true; },
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});
export default router;
