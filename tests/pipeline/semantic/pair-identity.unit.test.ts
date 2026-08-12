import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import type {
  //
  ClientFormat,
  UpstreamEndpoint,
} from "../../../src/lib/pipeline/envelope"
import type { ModelIdentity } from "../../../src/lib/pipeline/semantic/types"

import { bridgePairOf } from "../../../src/lib/pipeline/semantic/pair-identity"

const saved = snapshotStateForTests()
afterEach(() => {
  restoreStateForTests(saved)
})

const CLIENT_FORMATS: ReadonlyArray<ClientFormat> = ["anthropic", "openai-cc", "openai-responses", "gemini"]
const ENDPOINTS: ReadonlyArray<UpstreamEndpoint> = ["/v1/messages", "/chat/completions", "/responses", "ws:/responses"]

/** The pairs RFC §2 puts inside the bridge's scope. Everything else in the 4×4 space must be `undefined`. */
const IN_SCOPE: ReadonlyArray<readonly [ClientFormat, UpstreamEndpoint, ModelIdentity["protocol"], ModelIdentity["protocol"]]> = [
  ["anthropic", "/v1/messages", "anthropic", "anthropic"],
  ["anthropic", "/responses", "anthropic", "responses"],
  ["anthropic", "ws:/responses", "anthropic", "responses"],
  ["openai-responses", "/v1/messages", "responses", "anthropic"],
  ["openai-responses", "/responses", "responses", "responses"],
  ["openai-responses", "ws:/responses", "responses", "responses"],
]

describe("bridge pair identity (RFC §2 / §6)", () => {
  test("every in-scope routing combination maps to the documented protocol pair", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })

    for (const [clientFormat, targetEndpoint, source, target] of IN_SCOPE) {
      const pair = bridgePairOf({ clientFormat, targetEndpoint, model: "m" })
      expect(pair, `${clientFormat} -> ${targetEndpoint}`).toBeDefined()
      expect([pair?.source.protocol, pair?.target.protocol], `${clientFormat} -> ${targetEndpoint}`).toEqual([source, target])
    }
  })

  /**
   * The whole input space, not a sample. An out-of-scope leg must yield NO pair rather than the
   * nearest-looking one: mapping `openai-cc` onto `responses` would hand a real Chat-Completions
   * request a Responses policy, and the carrier rules that policy carries are protocol-specific.
   */
  test("every combination outside RFC §2's scope yields no pair at all", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const inScope = new Set(IN_SCOPE.map(([format, endpoint]) => `${format}|${endpoint}`))

    const unexpected: Array<string> = []
    for (const clientFormat of CLIENT_FORMATS) {
      for (const targetEndpoint of ENDPOINTS) {
        if (inScope.has(`${clientFormat}|${targetEndpoint}`)) continue
        if (bridgePairOf({ clientFormat, targetEndpoint, model: "m" }) !== undefined) unexpected.push(`${clientFormat} -> ${targetEndpoint}`)
      }
    }

    expect(unexpected).toEqual([])
    // Guards the guard: if someone extends either enum, the 4x4 sweep must grow with it rather than silently keep testing the old space.
    expect(CLIENT_FORMATS.length * ENDPOINTS.length - IN_SCOPE.length).toBe(10)
  })

  test("both sides name the same resolved model and the same live provider", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "business" })
    const pair = bridgePairOf({ clientFormat: "anthropic", targetEndpoint: "/responses", model: "gpt-5.6-sol" })

    expect(pair?.source).toEqual({ protocol: "anthropic", provider: "https://api.business.githubcopilot.com", model: "gpt-5.6-sol" })
    expect(pair?.target).toEqual({ protocol: "responses", provider: "https://api.business.githubcopilot.com", model: "gpt-5.6-sol" })
  })

  test("a pair is frozen, so a consumer cannot re-point a candidate's identity after resolution", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const pair = bridgePairOf({ clientFormat: "anthropic", targetEndpoint: "/responses", model: "m" })

    expect(Object.isFrozen(pair)).toBe(true)
    expect(Object.isFrozen(pair?.source)).toBe(true)
    expect(Object.isFrozen(pair?.target)).toBe(true)
  })
})
