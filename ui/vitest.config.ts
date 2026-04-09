import vue from "@vitejs/plugin-vue"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

const currentDirectory = import.meta.dirname

export default defineConfig({
  root: currentDirectory,
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(currentDirectory, "src"),
      "~backend": resolve(currentDirectory, "../../src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: [resolve(currentDirectory, "vitest/setup.ts")],
    include: [resolve(currentDirectory, "vitest/**/*.test.ts")],
    css: true,
  },
})
