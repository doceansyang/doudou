import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import postcssConfig from "../../postcss.config.ts";
import { i18nPlugin } from "@toonflow/i18n/vite";

// 版本号只有一个来源：仓库根的 package.json（发行脚本只改那一处）。
// 这里直接读文件而不是 import，避免 JSON 导入在不同打包器下的差异。
const appVersion: string = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version;

export default defineConfig({
  css: { postcss: postcssConfig },
  define: {
    "import.meta.env.appVersion": JSON.stringify(appVersion),
  },
  server: {
    proxy: {
      "/mcp": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/a2a": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (request, incoming) => {
            request.setHeader("x-toonflow-local-client", ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress ?? "") ? "1" : "0");
          });
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      { find: /^shiki$/, replacement: fileURLToPath(new URL("./src/lib/shiki.ts", import.meta.url)) },
    ],
  },
  build: {
    outDir: "../../build/web",
    emptyOutDir: true,
  },
  plugins: [
    i18nPlugin(),
    vue(),
    components({
      globsExclude: ["src/components/settings/panels/**/*Dialog.vue"],
      dts: "src/types/components.d.ts",
      resolvers: [
        ElementPlusResolver(),
        (name) => {
          if (name.startsWith("Icon")) return { name, from: "@tabler/icons-vue" };
        },
      ],
    }),
  ],
});
