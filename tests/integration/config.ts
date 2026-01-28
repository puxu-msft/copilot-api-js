/**
 * Shared test configuration for integration tests.
 * Loads environment variables and provides test utilities.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// Try to load .env file manually if not already loaded
function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), ".env")

  if (!existsSync(envPath)) {
    return
  }

  const content = readFileSync(envPath, "utf8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const [key, ...valueParts] = trimmed.split("=")
    const value = valueParts.join("=")

    if (key && value && !process.env[key]) {
      process.env[key] = value
    }
  }
}

// Load env on module import
loadEnvFile()

/**
 * Get GitHub token from environment.
 * Returns undefined if not available.
 */
export function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN
}

/**
 * Check if integration tests should run.
 * Returns true if GITHUB_TOKEN is available.
 */
export function shouldRunIntegrationTests(): boolean {
  const token = getGitHubToken()
  if (!token) {
    console.warn(
      "[Integration Tests] GITHUB_TOKEN not found. "
        + "Set it in .env file to run integration tests.",
    )
    return false
  }
  return true
}
