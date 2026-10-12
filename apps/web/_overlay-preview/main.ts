import { createApp, h, ref } from "vue";
import generationOverlay from "../../../packages/nodeScaffold/src/components/generationOverlay.vue";

// 挂载即开始，模拟"点下生成"那一刻。
// 同时铺三种尺寸，验证字号是否跟着容器缩放（容器查询 clamp）。
const app = createApp({
  setup() {
    const active = ref(false);
    setTimeout(() => { active.value = true; }, 30);
    return () =>
      h("div", { style: "display:flex;gap:18px;align-items:flex-start" }, [
        h("div", { class: "stage stage--sm" }, [h(generationOverlay, { active: active.value })]),
        h("div", { class: "stage" }, [h(generationOverlay, { active: active.value })]),
        h("div", { class: "stage stage--lg" }, [h(generationOverlay, { active: active.value })]),
      ]);
  },
});

app.mount("#app");
