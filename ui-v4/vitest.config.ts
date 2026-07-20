import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

const here = import.meta.dirname

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "~backend": resolve(here, "../src"),
      "~": resolve(here, "../src"),
    },
  },
  // 只跑 .vitest.test 文件;.bun.test 留给 `bun test`(它们 import bun:test,vitest 无法 bundle)。
  test: { environment: "jsdom", globals: true, setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.vitest.test.{ts,tsx}"] },
})
