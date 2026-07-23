import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["packages/cli/src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  // Runtime-specific sqlite modules must stay external so the bundler does
  // not try to resolve them at build time. The driver layer
  // (src/lib/history/sqlite/driver.ts) picks one at runtime based on detected
  // host (Bun vs Node).
  deps: {
    neverBundle: ["bun:sqlite", "node:sqlite"],
  },

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },
})
