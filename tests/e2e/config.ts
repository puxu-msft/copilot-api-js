/**
 * Shared E2E test configuration with real/mock/record modes.
 *
 * Modes:
 * - mock (default): Uses fixtures/ for API responses, no GITHUB_TOKEN needed
 * - real: Uses actual Copilot API, requires GITHUB_TOKEN
 * - record: Uses actual API AND saves responses to fixtures/, requires E2E_RECORD=1 + GITHUB_TOKEN
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// ─── Mode detection ───

export type E2EMode = "real" | "mock" | "record"

export function getE2EMode(): E2EMode {
  if (process.env.E2E_RECORD === "1") return "record"
  if (getGitHubToken()) return "real"
  return "mock"
}

export function isMockMode(): boolean {
  return getE2EMode() === "mock"
}

export function isRecordMode(): boolean {
  return getE2EMode() === "record"
}

// ─── Env loading (unchanged) ───

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

loadEnvFile()

/**
 * Get GitHub token from environment or from the copilot-api token file.
 */
export function getGitHubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN

  // Fall back to the token file used by copilot-api itself
  const tokenPath = join(homedir(), ".local", "share", "copilot-api", "github_token")
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim()
    if (token) return token
  }

  return undefined
}

/**
 * @deprecated Use getE2EMode() instead
 */
export function shouldRunIntegrationTests(): boolean {
  return getE2EMode() !== "mock"
}

// ─── Fixture management ───

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures")

export function fixtureExists(name: string): boolean {
  return existsSync(resolve(FIXTURES_DIR, name))
}

export function loadFixture(name: string): unknown {
  const path = resolve(FIXTURES_DIR, name)
  if (!existsSync(path)) {
    throw new Error(`Fixture not found: ${path}. Run with E2E_RECORD=1 to generate fixtures.`)
  }
  return JSON.parse(readFileSync(path, "utf8"))
}

export function saveFixture(name: string, data: unknown): void {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  writeFileSync(resolve(FIXTURES_DIR, name), JSON.stringify(data, null, 2))
}

/**
 * Load a fixture as a line-delimited stream (for SSE/streaming responses).
 */
export function loadFixtureStream(name: string): ReadableStream<Uint8Array> {
  const content = readFileSync(resolve(FIXTURES_DIR, name), "utf8")
  const encoder = new TextEncoder()
  const lines = content.split("\n")
  let index = 0

  return new ReadableStream({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(encoder.encode(lines[index] + "\n"))
        index++
      } else {
        controller.close()
      }
    },
  })
}
