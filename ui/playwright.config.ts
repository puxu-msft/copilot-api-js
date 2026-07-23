import { defineConfig } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_UI_PORT ?? 4173)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.pw\.ts/,
  timeout: 30000,
  retries: 1,
  use: {
    baseURL,
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  // Auto-starts `vite preview` against the already-built dist/ (run `bun run
  // build` first — this workspace's own test:e2e script does that). Reuses an
  // already-running server (e.g. a manually started `vite preview`/`vite dev`)
  // instead of spawning a second one when PLAYWRIGHT_BASE_URL points at it.
  webServer: process.env.PLAYWRIGHT_BASE_URL ?
    undefined
  : {
      command: `bunx vite preview --port ${port}`,
      url: baseURL,
      reuseExistingServer: true,
      timeout: 30000,
    },
})
