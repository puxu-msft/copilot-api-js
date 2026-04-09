import { describe, expect, test } from "bun:test"

import viteConfig from "../vite.config"

describe("vite config", () => {
  test("pre-bundles route-scoped frontend dependencies in dev", () => {
    const config = viteConfig({ command: "serve", isSsrBuild: false, isPreview: false, mode: "development" })
    const include = config.optimizeDeps?.include ?? []

    expect(include).toContain("vue-json-pretty")
    expect(include).toContain("diff")
    expect(include).toContain("diff2html")
  })
})
