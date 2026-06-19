import {
  //
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  getUnsupportedServerToolTypes,
  isAnthropicBetaUnsupported,
  loadPersistedFeatureNegotiation,
  markAnthropicBetaUnsupported,
  markAnthropicServerToolUnsupported,
  persistFeatureNegotiation,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"

// Sandbox the persisted path for the whole file so neither persist() nor the
// reset()'s internal drain ever touches the real negotiation-states.json.
let tmpDir = ""
let realPath = ""

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-srvtools-"))
  realPath = PATHS.NEGOTIATION_STATES
  PATHS.NEGOTIATION_STATES = path.join(tmpDir, "negotiation-states.json")
})

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

afterAll(async () => {
  PATHS.NEGOTIATION_STATES = realPath
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("feature negotiation cache — server tools", () => {
  test("mark + get round-trips", () => {
    markAnthropicServerToolUnsupported("claude-3-5-sonnet", "web_search_")
    expect(getUnsupportedServerToolTypes("claude-3-5-sonnet")).toEqual(["web_search_"])
  })

  test("entries are per-model", () => {
    markAnthropicServerToolUnsupported("m1", "web_search_")
    expect(getUnsupportedServerToolTypes("m2")).toEqual([])
  })

  test("ignores empty / whitespace tool types", () => {
    markAnthropicServerToolUnsupported("m1", "")
    markAnthropicServerToolUnsupported("m1", "   ")
    expect(getUnsupportedServerToolTypes("m1")).toEqual([])
  })

  test("dedupes repeated marks", () => {
    markAnthropicServerToolUnsupported("m1", "web_search_")
    markAnthropicServerToolUnsupported("m1", "web_search_")
    expect(getUnsupportedServerToolTypes("m1")).toEqual(["web_search_"])
  })
})

describe("feature negotiation cache — server tools persistence", () => {
  test("persist → load round-trips serverTools", async () => {
    markAnthropicServerToolUnsupported("claude-3-5-sonnet", "web_search_")
    await persistFeatureNegotiation()

    await resetAnthropicFeatureNegotiationForTesting()
    expect(getUnsupportedServerToolTypes("claude-3-5-sonnet")).toEqual([])

    await loadPersistedFeatureNegotiation()
    expect(getUnsupportedServerToolTypes("claude-3-5-sonnet")).toEqual(["web_search_"])
  })

  test("loads an old file missing the serverTools key without breaking other categories", async () => {
    // Build a real persisted file (keys match modelKey() internals), then strip
    // the serverTools key to simulate a file written before this category existed.
    markAnthropicBetaUnsupported("m", "some-beta")
    await persistFeatureNegotiation()
    const raw = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8")) as Record<string, unknown>
    delete raw.serverTools
    await fs.writeFile(PATHS.NEGOTIATION_STATES, JSON.stringify(raw), "utf8")

    await resetAnthropicFeatureNegotiationForTesting()
    await loadPersistedFeatureNegotiation()

    // serverTools defaults to empty (missing key → loadSetMap returns nothing)
    expect(getUnsupportedServerToolTypes("m")).toEqual([])
    // The legacy betas key still loads — backward compat intact.
    expect(isAnthropicBetaUnsupported("m", "some-beta")).toBe(true)
  })
})
