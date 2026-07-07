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
  clearAnthropicFeatureNegotiationForTests,
  getStickyUndeferredTools,
  getSupportedEfforts,
  getUnsupportedFeatures,
  isAnthropicBetaUnsupported,
  isAnthropicFeatureUnsupported,
  isSystemRejectModelLearned,
  isToolStickyUndeferred,
  loadPersistedFeatureNegotiation,
  markAnthropicBetaUnsupported,
  markAnthropicFeatureUnsupported,
  markSystemRejectModel,
  markToolUndeferred,
  persistFeatureNegotiation,
  resetAnthropicFeatureNegotiationForTesting,
  setSupportedEfforts,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"

// Sandbox the persisted path so mark()'s debounced persist and the golden
// persist→reload never touch the real negotiation-states.json (this is an
// explicit per-file override on top of the bunfig preload floor).
let tmpDir = ""
let realPath = ""

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-system-reject-"))
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

describe("systemRejectModels (inline role:system rejection set)", () => {
  test("mark then is — normalized membership, endpoint-scoped", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(isSystemRejectModelLearned("claude-sonnet-4.6")).toBe(false)
    markSystemRejectModel("claude-sonnet-4.6")
    expect(isSystemRejectModelLearned("claude-sonnet-4.6")).toBe(true)
    // normalization: dotted vs dashed are the same key
    expect(isSystemRejectModelLearned("claude-sonnet-4-6")).toBe(true)
    // an unrelated model is not marked
    expect(isSystemRejectModelLearned("claude-opus-4.8")).toBe(false)
  })

  test("golden: persist → reload keeps the learned reject model across restart", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markSystemRejectModel("claude-haiku-4.5")
    await persistFeatureNegotiation()
    clearAnthropicFeatureNegotiationForTests()
    expect(isSystemRejectModelLearned("claude-haiku-4.5")).toBe(false) // wiped
    await loadPersistedFeatureNegotiation()
    expect(isSystemRejectModelLearned("claude-haiku-4.5")).toBe(true) // survived
  })
})

describe("feature negotiation cache — features", () => {
  test("mark + check round-trips", () => {
    markAnthropicFeatureUnsupported("claude-opus-4.6", "context_management")
    expect(isAnthropicFeatureUnsupported("claude-opus-4.6", "context_management")).toBe(true)
  })

  test("getUnsupportedFeatures returns all", () => {
    markAnthropicFeatureUnsupported("m1", "context_management")
    markAnthropicFeatureUnsupported("m1", "another_field")
    expect(getUnsupportedFeatures("m1").sort()).toEqual(["another_field", "context_management"])
  })

  test("entries are per-model", () => {
    markAnthropicFeatureUnsupported("m1", "x")
    expect(isAnthropicFeatureUnsupported("m2", "x")).toBe(false)
  })
})

describe("feature negotiation cache — betas", () => {
  test("mark + check round-trips", () => {
    markAnthropicBetaUnsupported("claude-opus-4.7-1m-internal", "context-1m-2025-08-07")
    expect(isAnthropicBetaUnsupported("claude-opus-4.7-1m-internal", "context-1m-2025-08-07")).toBe(true)
  })

  test("ignores empty/whitespace tokens", () => {
    markAnthropicBetaUnsupported("m1", "")
    markAnthropicBetaUnsupported("m1", "   ")
    expect(isAnthropicBetaUnsupported("m1", "")).toBe(false)
  })
})

describe("feature negotiation cache — efforts", () => {
  test("set + get round-trips", () => {
    expect(setSupportedEfforts("claude-opus-4.7", ["medium"])).toBe(true)
    expect(getSupportedEfforts("claude-opus-4.7")).toEqual(["medium"])
  })

  test("set returns false when value is unchanged", () => {
    setSupportedEfforts("claude-opus-4.7", ["medium"])
    expect(setSupportedEfforts("claude-opus-4.7", ["medium"])).toBe(false)
  })

  test("set returns true when value differs", () => {
    setSupportedEfforts("m1", ["low"])
    expect(setSupportedEfforts("m1", ["low", "medium"])).toBe(true)
    expect(getSupportedEfforts("m1")).toEqual(["low", "medium"])
  })
})

describe("feature negotiation cache — deferred tools", () => {
  test("mark + check round-trips", () => {
    markToolUndeferred("claude-opus-4.6", "read_file")
    expect(isToolStickyUndeferred("claude-opus-4.6", "read_file")).toBe(true)
    expect(getStickyUndeferredTools("claude-opus-4.6")).toEqual(["read_file"])
  })

  test("ignores empty tool names", () => {
    markToolUndeferred("m1", "")
    expect(getStickyUndeferredTools("m1")).toEqual([])
  })

  test("entries are per-model", () => {
    markToolUndeferred("m1", "Read")
    expect(isToolStickyUndeferred("m2", "Read")).toBe(false)
  })
})

describe("feature negotiation cache — reset clears everything", () => {
  test("all categories reset", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    markAnthropicBetaUnsupported("m", "b")
    setSupportedEfforts("m", ["medium"])
    markToolUndeferred("m", "t")
    await resetAnthropicFeatureNegotiationForTesting()
    expect(isAnthropicFeatureUnsupported("m", "f")).toBe(false)
    expect(isAnthropicBetaUnsupported("m", "b")).toBe(false)
    expect(getSupportedEfforts("m")).toBeUndefined()
    expect(isToolStickyUndeferred("m", "t")).toBe(false)
  })
})
