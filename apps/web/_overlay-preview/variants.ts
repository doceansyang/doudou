import { createApp, h, ref } from "vue";
import strandsBackdrop from "../../../packages/nodeScaffold/src/components/strandsBackdrop.vue";

// 调丝带参数用的对照栅格。
//
// ⚠️ 第一版栅格是**每个参数只截一帧** —— 结论不可信。丝带是周期波，截到哪一刻
//    全凭运气：同一个参数这次是优雅的"蝠鲼"，下次就变成"蝴蝶"。必须**看相位**。
//    做法：**错开挂载时间**（每 4.2 秒放一行），于是同一列参数会同时出现在三个
//    不同相位上，一张图就能看出它稳不稳。
const COLORS = ["#7c3aed", "#ff9ffc", "#4c1dff"];

const columns = [
  { name: "amp1.3", props: { colors: COLORS, amplitude: 1.3, count: 3, thickness: 0.7, intensity: 0.4, glow: 2.0 } },
  { name: "amp1.8", props: { colors: COLORS, amplitude: 1.8, count: 3, thickness: 0.7, intensity: 0.4, glow: 2.0 } },
  { name: "amp2.4", props: { colors: COLORS, amplitude: 2.4, count: 3, thickness: 0.7, intensity: 0.4, glow: 2.0 } },
];

const app = createApp({
  setup() {
    const waves = ref(0);
    [4200, 8400, 12600].forEach((ms, i) => setTimeout(() => { waves.value = i + 1; }, ms));
    return () => h("div", { class: "grid" }, [0, 1, 2].flatMap((row) =>
      columns.map((c) => h("div", { class: "cell" }, [
        row < waves.value
          ? h("div", { class: "tile" }, [
              h(strandsBackdrop, c.props),
              h("span", { class: "scrim" }),
            ])
          : h("div", { class: "tile tile--empty" }),
        h("span", { class: "tag" }, `${c.name}  · 相位 +${(row * 4.2).toFixed(1)}s`),
      ])),
    ));
  },
});

app.mount("#app");
