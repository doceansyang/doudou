import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 只为「生成中遮罩」单开一条预览构建链：把真实组件打成一个自包含的
// IIFE + 一份 CSS，交给 Playwright 用 setContent 内联渲染。
// 目的不是出产品，而是**交付前真跑一次**——语法/编译通过不算验证，
// 得看到它渲染出来、动画在动、百分比在爬。
//
// ⚠️ `vue` 只装在 apps/web/node_modules（根目录没有），而组件文件在
//    packages/ 下，靠 Node 向上查找会找不到 → 这里显式 alias 到 apps/web 的那份。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  define: { "process.env.NODE_ENV": '"production"' },
  resolve: {
    alias: { vue: fileURLToPath(new URL("../node_modules/vue", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    // 允许换入口：调参数时用 variants.ts 铺一版对照栅格，交付验证仍走 main.ts
    lib: { entry: fileURLToPath(new URL(process.env.OVERLAY_ENTRY || "./main.ts", import.meta.url)), name: "GenOverlayPreview", formats: ["iife"], fileName: () => "preview.js" },
    rollupOptions: { output: { assetFileNames: "preview.[ext]" } },
  },
});
