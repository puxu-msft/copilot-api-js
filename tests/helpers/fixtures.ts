/**
 * Fixture loading utilities for real API request/response data.
 *
 * Fixtures are captured from live Copilot API calls and stored as JSON files.
 * They serve as regression tests — ensuring code changes don't break
 * the structure of real API data flowing through the system.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { EndpointType } from "~/lib/history/store"

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures")

type Scenario = "simple" | "tool-use" | "tool-call" | "function-call"

/** Load a fixture JSON file */
function loadFixture(format: EndpointType, scenario: Scenario, filename: string): unknown {
  const filePath = join(FIXTURES_DIR, format, scenario, filename)
  const content = readFileSync(filePath, "utf8")
  return JSON.parse(content) as unknown
}

/** Load a request/response pair for a given format and scenario */
export function loadFixturePair(format: EndpointType, scenario: Scenario): { request: any; response: any } {
  return {
    request: loadFixture(format, scenario, "request.json"),
    response: loadFixture(format, scenario, "response.json"),
  }
}

/** Load a follow-up request/response pair (tool result round-trip) */
export function loadFollowupPair(format: EndpointType, scenario: Scenario): { request: any; response: any } {
  return {
    request: loadFixture(format, scenario, "followup-request.json"),
    response: loadFixture(format, scenario, "followup-response.json"),
  }
}
