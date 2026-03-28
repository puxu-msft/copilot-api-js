/**
 * Model endpoint completeness tests using real Copilot API data.
 *
 * Verifies that every model's declared `supported_endpoints` matches our routing
 * assumptions, using live model data from the Copilot API.
 */

import { beforeAll, describe, expect, test } from "bun:test"

import type { Model } from "~/lib/models/client"

import { getModels } from "~/lib/models/client"
import { ENDPOINT, isEndpointSupported, isResponsesSupported } from "~/lib/models/endpoint"
import { rebuildModelIndex, state } from "~/lib/state"
import { getCopilotToken } from "~/lib/token/copilot-client"

import { getE2EMode, getGitHubToken } from "./config"

// Skip all tests if no token available
const describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip

describeWithToken("Model endpoint completeness", () => {
  let allModels: Array<Model>
  let chatModels: Array<Model>

  beforeAll(async () => {
    const githubToken = getGitHubToken()
    if (!githubToken) throw new Error("GITHUB_TOKEN required")

    state.githubToken = githubToken
    state.accountType = "individual"

    const { token } = await getCopilotToken()
    state.copilotToken = token

    const models = await getModels()
    if (!models?.data) throw new Error("Failed to fetch models")
    state.models = models
    rebuildModelIndex()

    allModels = models.data
    // Exclude embedding models from routing tests
    chatModels = allModels.filter((m) => !m.id.includes("embedding"))

    console.log(`[Setup] Loaded ${allModels.length} models (${chatModels.length} chat models)`)
  }, 30000)

  // ============================================================================
  // Reachability
  // ============================================================================

  test("every chat model is reachable via at least one endpoint", () => {
    const unreachable: Array<string> = []
    for (const model of chatModels) {
      const canReach =
        isEndpointSupported(model, ENDPOINT.MESSAGES)
        || isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)
        || isResponsesSupported(model)
      if (!canReach) {
        unreachable.push(`${model.id} (endpoints: ${JSON.stringify(model.supported_endpoints)})`)
      }
    }
    expect(unreachable).toEqual([])
  })

  // ============================================================================
  // Vendor ↔ endpoint consistency
  // ============================================================================

  test("all Anthropic vendor models support /v1/messages", () => {
    const anthropicVendor = chatModels.filter((m) => m.vendor === "Anthropic")
    const failures: Array<string> = []
    for (const model of anthropicVendor) {
      if (!isEndpointSupported(model, ENDPOINT.MESSAGES)) {
        failures.push(model.id)
      }
    }
    expect(failures).toEqual([])
  })

  test("all Anthropic vendor models also support /chat/completions", () => {
    const anthropicVendor = chatModels.filter((m) => m.vendor === "Anthropic")
    const failures: Array<string> = []
    for (const model of anthropicVendor) {
      if (!isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)) {
        failures.push(model.id)
      }
    }
    expect(failures).toEqual([])
  })

  // ============================================================================
  // Structural invariants
  // ============================================================================

  test("no model supports only /v1/messages without /chat/completions", () => {
    const messagesOnly = chatModels.filter(
      (m) =>
        m.supported_endpoints
        && m.supported_endpoints.includes(ENDPOINT.MESSAGES)
        && !m.supported_endpoints.includes(ENDPOINT.CHAT_COMPLETIONS),
    )
    expect(messagesOnly.map((m) => m.id)).toEqual([])
  })

  test("legacy models (no supported_endpoints) are reachable via fallback", () => {
    const legacyModels = chatModels.filter((m) => !m.supported_endpoints || m.supported_endpoints.length === 0)
    // All legacy models should be reachable because isEndpointSupported returns true
    // when supported_endpoints is absent
    for (const model of legacyModels) {
      expect(isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    }
    if (legacyModels.length > 0) {
      console.log(
        `[Legacy] ${legacyModels.length} models without supported_endpoints: ${legacyModels.map((m) => m.id).join(", ")}`,
      )
    }
  })

  test("every model lists only known endpoints", () => {
    const knownEndpoints = new Set([
      ENDPOINT.MESSAGES,
      ENDPOINT.CHAT_COMPLETIONS,
      ENDPOINT.RESPONSES,
      ENDPOINT.WS_RESPONSES,
      ENDPOINT.EMBEDDINGS,
    ])
    const unknownEndpoints: Array<{ model: string; endpoint: string }> = []

    for (const model of allModels) {
      if (!model.supported_endpoints) continue
      for (const ep of model.supported_endpoints) {
        if (!knownEndpoints.has(ep as (typeof ENDPOINT)[keyof typeof ENDPOINT])) {
          unknownEndpoints.push({ model: model.id, endpoint: ep })
        }
      }
    }
    if (unknownEndpoints.length > 0) {
      console.warn(`[Warning] Unknown endpoints found:`, unknownEndpoints)
    }
    expect(unknownEndpoints).toEqual([])
  })

  // ============================================================================
  // Distribution snapshot (informational, documents current state)
  // ============================================================================

  test("model distribution by endpoint pattern", () => {
    const patterns = new Map<string, Array<string>>()
    for (const model of chatModels) {
      const key =
        model.supported_endpoints ? model.supported_endpoints.slice().sort().join(" + ") || "(empty)" : "(legacy)"
      if (!patterns.has(key)) patterns.set(key, [])
      patterns.get(key)!.push(model.id)
    }

    console.log("\n[Distribution] Model endpoint patterns:")
    for (const [pattern, models] of [...patterns.entries()].sort()) {
      console.log(`  ${pattern}: ${models.length} models (${models.join(", ")})`)
    }

    // At minimum, we expect these categories to exist
    expect(chatModels.length).toBeGreaterThan(0)
    expect(patterns.size).toBeGreaterThan(1)
  })
})
