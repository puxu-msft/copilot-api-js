import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    main: "packages/cli/src/main.ts",
    "history-worker": "src/lib/history/worker/history-worker.ts",
    // Its own entry because it is spawned as a Worker by URL at runtime, not imported. Without this it never reaches `dist/`, and `resolveTokenizerWorkerUrl` resolves to a file that only exists in the source tree — a failure that appears in production builds only, and only on the first token count.
    "tokenizer-worker": "src/lib/models/tokenizer-worker.ts",
  },

  format: ["esm"],
  target: "es2022",
  platform: "node",

  // Runtime-specific sqlite modules must stay external so the bundler does
  // not try to resolve them at build time. The driver layer
  // (packages/foundation/src/sqlite/driver.ts) picks one at runtime based on detected
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
