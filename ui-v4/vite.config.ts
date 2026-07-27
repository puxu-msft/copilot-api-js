import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig } from "vite"

const here = import.meta.dirname

export default defineConfig(({ command }) => {
  const backendHost = process.env.COPILOT_API_HOST ?? "localhost"
  const backendPort = process.env.COPILOT_API_PORT ?? "4141"
  const backendHttpUrl = `http://${backendHost}:${backendPort}`
  const backendWsUrl = `ws://${backendHost}:${backendPort}`

  return {
    root: here,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(here, "src"),
        // The telemetry domain is a workspace package now, so its snapshot types no longer live
        // under `~backend`. `/types` is the package's PURE-TYPE barrel — it can never drag the
        // backend runtime (consola / bun:sqlite / DDSketch) into the browser bundle.
        "@hsupu/ghc-proxy-telemetry/types": resolve(here, "../packages/telemetry/src/types.ts"),
        "~backend": resolve(here, "../src"),
        "~": resolve(here, "../src"),
      },
    },
    base: command === "serve" ? "/" : "/ui-v4/",
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      proxy: {
        "/history/api": { target: backendHttpUrl, changeOrigin: true },
        "/ws": { target: backendWsUrl, ws: true },
        "/api": { target: backendHttpUrl, changeOrigin: true },
        "/models": { target: backendHttpUrl, changeOrigin: true },
      },
    },
  }
})
