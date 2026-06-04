import vue from "@vitejs/plugin-vue"
import { resolve } from "node:path"
import AutoImport from "unplugin-auto-import/vite"
import Components from "unplugin-vue-components/vite"
import { defineConfig } from "vite"
import VueDevTools from "vite-plugin-vue-devtools"
import vuetify from "vite-plugin-vuetify"

export default defineConfig(({ command }) => {
  const backendHost = process.env.COPILOT_API_HOST ?? "localhost"
  const backendPort = process.env.COPILOT_API_PORT ?? "4141"
  const backendHttpUrl = `http://${backendHost}:${backendPort}`
  const backendWsUrl = `ws://${backendHost}:${backendPort}`

  return {
    root: __dirname,
    plugins: [
      vue(),
      vuetify({ autoImport: true }),
      VueDevTools(),
      AutoImport({
        imports: ["vue", "vue-router", "pinia", "@vueuse/core"],
        dts: resolve(__dirname, "types/auto-imports.d.ts"),
      }),
      Components({
        dirs: [resolve(__dirname, "src/components")],
        dts: resolve(__dirname, "types/components.d.ts"),
      }),
    ],
    optimizeDeps: {
      include: ["vue-json-pretty", "diff", "diff2html"],
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "~backend": resolve(__dirname, "../src"),
      },
    },
    // In dev mode, serve from root for convenience; in build, use /ui/ prefix
    base: command === "serve" ? "/" : "/ui/",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            vue: ["vue", "vue-router"],
            vendor: ["vue-json-pretty", "diff", "diff2html"],
          },
        },
      },
    },
    server: {
      proxy: {
        "/history/api": {
          target: backendHttpUrl,
          changeOrigin: true,
        },
        "/ws": {
          target: backendWsUrl,
          ws: true,
        },
        "/api": {
          target: backendHttpUrl,
          changeOrigin: true,
        },
        "/models": {
          target: backendHttpUrl,
          changeOrigin: true,
        },
      },
    },
  }
})
