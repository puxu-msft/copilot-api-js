import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests/e2e-ui",
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4141",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  // Server will be started manually before tests
})
