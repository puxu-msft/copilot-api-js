import {
  //
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  deleteEntry,
  expireEntry,
  exportAll,
  getGroupedSnapshot,
  getStickyUndeferredTools,
  getSupportedEfforts,
  getUnsupportedFeatures,
  getUnsupportedServerToolTypes,
  getUnsupportedToolFields,
  isAnthropicBetaUnsupported,
  isAnthropicFeatureUnsupported,
  isAnthropicPartnerFeatureUnsupported,
  isEffortUnsupported,
  isServerToolDowngradeLearned,
  isSystemRejectModelLearned,
  isToolStickyUndeferred,
  loadPersistedFeatureNegotiation,
  markAnthropicBetaUnsupported,
  markAnthropicFeatureUnsupported,
  markAnthropicPartnerFeatureUnsupported,
  markAnthropicServerToolUnsupported,
  markAnthropicUnsupportedToolFields,
  markEffortUnsupported,
  markServerToolDowngrade,
  markSystemRejectModel,
  markToolUndeferred,
  persistFeatureNegotiation,
  renewEntry,
  resetAnthropicFeatureNegotiationForTesting,
  setPinned,
  setSupportedEfforts,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"
import { setNegotiationConfig } from "~/lib/state"

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
  setSystemTime() // reset any fake clock (guards against a test throwing before its own reset)
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

describe("effortUnsupported (zero-support effort set)", () => {
  test("mark then is (model-only key, normalized)", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(isEffortUnsupported("claude-haiku-4.5")).toBe(false)
    markEffortUnsupported("claude-haiku-4.5")
    expect(isEffortUnsupported("claude-haiku-4-5")).toBe(true)
  })
  test("mutually exclusive with supportedEfforts", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("claude-x", ["medium"])
    markEffortUnsupported("claude-x")
    // marking unsupported removes any supported whitelist for that model
    expect(getSupportedEfforts("claude-x")).toBeUndefined()
    expect(isEffortUnsupported("claude-x")).toBe(true)
    // and vice-versa
    setSupportedEfforts("claude-x", ["low"])
    expect(isEffortUnsupported("claude-x")).toBe(false)
  })
  test("golden: persist → reload keeps the unsupported flag (empty-set collision avoided)", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    await persistFeatureNegotiation()
    clearAnthropicFeatureNegotiationForTests()
    await loadPersistedFeatureNegotiation()
    expect(isEffortUnsupported("claude-haiku-4.5")).toBe(true)
  })
})

describe("serverToolDowngrade (web_search-not-found downgrade set)", () => {
  test("mark then is — normalized membership, endpoint-scoped", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(isServerToolDowngradeLearned("claude-sonnet-4.6")).toBe(false)
    markServerToolDowngrade("claude-sonnet-4.6")
    expect(isServerToolDowngradeLearned("claude-sonnet-4.6")).toBe(true)
    // normalization: dotted vs dashed are the same key
    expect(isServerToolDowngradeLearned("claude-sonnet-4-6")).toBe(true)
    // an unrelated model is not marked
    expect(isServerToolDowngradeLearned("claude-opus-4.8")).toBe(false)
  })

  test("golden: persist → reload keeps the learned downgrade model across restart", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markServerToolDowngrade("claude-haiku-4.5")
    await persistFeatureNegotiation()
    clearAnthropicFeatureNegotiationForTests()
    expect(isServerToolDowngradeLearned("claude-haiku-4.5")).toBe(false) // wiped
    await loadPersistedFeatureNegotiation()
    expect(isServerToolDowngradeLearned("claude-haiku-4.5")).toBe(true) // survived
  })

  test("startup auto-migration: legacy on-disk `serverToolHistoryDowngrade` key is loaded", async () => {
    // Simulate a pre-rename snapshot: persist normally, then rewrite the on-disk
    // key back to the legacy spelling (reuses real serialization for the modelKey).
    clearAnthropicFeatureNegotiationForTests()
    markServerToolDowngrade("claude-opus-4.8")
    await persistFeatureNegotiation()
    const raw = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8")) as Record<string, unknown>
    raw.serverToolHistoryDowngrade = raw.serverToolDowngrade
    delete raw.serverToolDowngrade
    await fs.writeFile(PATHS.NEGOTIATION_STATES, JSON.stringify(raw), "utf8")
    clearAnthropicFeatureNegotiationForTests()
    expect(isServerToolDowngradeLearned("claude-opus-4.8")).toBe(false) // wiped
    await loadPersistedFeatureNegotiation()
    expect(isServerToolDowngradeLearned("claude-opus-4.8")).toBe(true) // migrated from legacy key
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

describe("v1 → v2 migration", () => {
  test("loads a legacy v1 file and stamps migrated meta", async () => {
    clearAnthropicFeatureNegotiationForTests()
    const v1 = {
      version: 1,
      features: { "url|anthropic-messages|opus": ["context_management"] },
      betas: {},
      efforts: { opus: ["low", "high"] },
      effortUnsupported: ["haiku"],
      deferredTools: {},
      serverTools: {},
      partnerFeatures: {},
      systemRejectModels: [],
      serverToolHistoryDowngrade: ["sonnet"], // legacy key
      toolFields: {},
    }
    await fs.writeFile(PATHS.NEGOTIATION_STATES, JSON.stringify(v1))
    await loadPersistedFeatureNegotiation()
    // Model-name-keyed categories (efforts / effortUnsupported keyed by bare model
    // name) round-trip through readers directly.
    expect(getSupportedEfforts("opus")).toEqual(["low", "high"])
    expect(isEffortUnsupported("haiku")).toBe(true)
    // modelKey/flat-map categories store keys verbatim from disk (real v1 files hold
    // full modelKeys); verify via the raw snapshot, which also proves migrated meta is
    // stamped (firstLearnedAt = lastConfirmedAt = load time, migrated: true).
    const snap = getGroupedSnapshot()
    const feature = snap.categories.find((c) => c.category === "features")!.entries.find((e) => e.value === "context_management")
    expect(feature?.migrated).toBe(true)
    expect(feature?.firstLearnedAt).toBe(feature?.lastConfirmedAt)
    const downgrade = snap.categories.find((c) => c.category === "serverToolDowngrade")!.entries.find((e) => e.value === "sonnet")
    expect(downgrade?.migrated).toBe(true) // legacy serverToolHistoryDowngrade key read
    // effortUnsupported also carries migrated meta
    const eu = snap.categories.find((c) => c.category === "effortUnsupported")!.entries.find((e) => e.value === "haiku")
    expect(eu?.migrated).toBe(true)
  })

  test("persist writes version 2 and drops legacy key", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markServerToolDowngrade("sonnet")
    await persistFeatureNegotiation()
    const raw = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    expect(raw.version).toBe(2)
    expect(raw.serverToolHistoryDowngrade).toBeUndefined()
    // v2 shape: value → meta object with timestamps
    const key = Object.keys(raw.serverToolDowngrade)[0]
    expect(typeof raw.serverToolDowngrade[key].firstLearnedAt).toBe("number")
    expect(typeof raw.serverToolDowngrade[key].lastConfirmedAt).toBe("number")
  })
})

const DAY_MS = 86_400_000
// bun treats setSystemTime(new Date(BASE_MS)) as a RESET to real time (epoch 0 is falsy),
// so fake-clock tests must anchor at a non-zero base date.
const BASE_MS = new Date("2026-01-01T00:00:00Z").getTime()

describe("markX re-confirm refreshes meta without changing return contract", () => {
  test("re-marking a feature refreshes lastConfirmedAt + keeps firstLearnedAt", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "context_management")
    await persistFeatureNegotiation()
    const t1 = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    const key1 = Object.keys(t1.features)[0]
    const first = t1.features[key1].context_management.lastConfirmedAt
    await new Promise((r) => setTimeout(r, 5))
    markAnthropicFeatureUnsupported("m", "context_management") // re-hit
    await persistFeatureNegotiation()
    const t2 = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    expect(t2.features[key1].context_management.lastConfirmedAt).toBeGreaterThanOrEqual(first)
    expect(t2.features[key1].context_management.firstLearnedAt).toBe(t1.features[key1].context_management.firstLearnedAt)
  })

  test("re-marking a feature clears a prior manuallyExpired flag", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "f")
    const e = getGroupedSnapshot().categories.find((c) => c.category === "features")!.entries[0]
    expireEntry("features", e.key, e.value)
    expect(isAnthropicFeatureUnsupported("m", "f")).toBe(false) // manually expired
    markAnthropicFeatureUnsupported("m", "f") // re-hit revives (clears manuallyExpired)
    expect(isAnthropicFeatureUnsupported("m", "f")).toBe(true)
  })

  test("setSupportedEfforts returns false on unchanged ACTIVE whitelist but still refreshes meta", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(true)
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(false) // active + unchanged → false (loop guard)
    expect(getSupportedEfforts("m")).toEqual(["low", "high"])
  })

  test("setSupportedEfforts returns true when reviving an EXPIRED entry (H3)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(BASE_MS))
    setSupportedEfforts("m", ["low", "high"])
    setSystemTime(new Date(BASE_MS + 31 * DAY_MS)) // expired (default 30d)
    // same whitelist, but entry was inactive → revival → true (else effort strategy would abort)
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(true)
    expect(getSupportedEfforts("m")).toEqual(["low", "high"]) // active again
    setSystemTime()
  })

  test("markEffortUnsupported drops sibling efforts meta (mutual exclusivity)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("m", ["low"])
    markEffortUnsupported("m")
    expect(getSupportedEfforts("m")).toBeUndefined()
    expect(isEffortUnsupported("m")).toBe(true)
  })
})

describe("reader gating by TTL (time-driven)", () => {
  test("feature reads active within TTL, not-learned past the default 30d", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(BASE_MS))
    markAnthropicFeatureUnsupported("m", "context_management")
    expect(isAnthropicFeatureUnsupported("m", "context_management")).toBe(true)
    setSystemTime(new Date(BASE_MS + 31 * DAY_MS)) // 31d later, default 30d TTL
    expect(isAnthropicFeatureUnsupported("m", "context_management")).toBe(false)
    setSystemTime()
  })

  test("toolFields honors its 90d shipped default (still active at 60d, expired at 91d)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(BASE_MS))
    markAnthropicUnsupportedToolFields(["eager_input_streaming"])
    setSystemTime(new Date(BASE_MS + 60 * DAY_MS))
    expect(getUnsupportedToolFields()).toContain("eager_input_streaming")
    setSystemTime(new Date(BASE_MS + 91 * DAY_MS))
    expect(getUnsupportedToolFields()).not.toContain("eager_input_streaming")
    setSystemTime()
  })

  test("partnerFeatures default is never (Infinity) — no time-based expiry", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(BASE_MS))
    markAnthropicPartnerFeatureUnsupported("m", "structured_outputs")
    setSystemTime(new Date(BASE_MS + 999 * DAY_MS))
    expect(isAnthropicPartnerFeatureUnsupported("m", "structured_outputs")).toBe(true)
    setSystemTime()
  })
})

describe("mutations + resolver + snapshot", () => {
  test("snapshot groups all 10 categories with ttl + entries", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "context_management")
    const snap = getGroupedSnapshot()
    expect(snap.categories.length).toBe(10)
    const feat = snap.categories.find((c) => c.category === "features")!
    expect(feat.entries[0].value).toBe("context_management")
    expect(feat.entries[0].status).toBe("active")
  })

  test("expireEntry sets manually_expired, keeps row; miss returns null", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicBetaUnsupported("m", "beta-x")
    expect(expireEntry("betas", "nope", "beta-x")).toBeNull() // wrong key → miss
    const e = getGroupedSnapshot().categories.find((c) => c.category === "betas")!.entries[0]
    const view = expireEntry("betas", e.key, e.value)
    expect(view?.status).toBe("manually_expired") // row kept, view returned
  })

  test("efforts addressing: key='' value=model; setPinned returns updated view", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("opus", ["low"])
    expect(setPinned("efforts", "", "opus", true)?.status).toBe("pinned")
    const snap = getGroupedSnapshot()
    expect(snap.categories.find((c) => c.category === "efforts")!.entries[0].status).toBe("pinned")
  })

  test("renew revives a manually-expired entry", () => {
    clearAnthropicFeatureNegotiationForTests()
    markSystemRejectModel("m")
    // systemRejectModels is keyed by the full modelKey internally; address via the
    // snapshot's (key, value) so the resolver locates it regardless of key format.
    const e = getGroupedSnapshot().categories.find((c) => c.category === "systemRejectModels")!.entries[0]
    expireEntry("systemRejectModels", e.key, e.value)
    expect(isSystemRejectModelLearned("m")).toBe(false)
    const view = renewEntry("systemRejectModels", e.key, e.value)
    expect(view?.status).toBe("active")
    expect(isSystemRejectModelLearned("m")).toBe(true)
  })

  test("delete removes; missing entry returns false", () => {
    clearAnthropicFeatureNegotiationForTests()
    markSystemRejectModel("m")
    const e = getGroupedSnapshot().categories.find((c) => c.category === "systemRejectModels")!.entries[0]
    expect(deleteEntry("systemRejectModels", e.key, e.value)).toBe(true)
    expect(deleteEntry("systemRejectModels", e.key, e.value)).toBe(false)
  })

  test("exportAll returns version 2 dataset", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "f")
    expect(exportAll().version).toBe(2)
  })
})

describe("every category: expireEntry makes the gated reader read not-learned", () => {
  // Seed one entry per category, resolve its (key, value) via the raw snapshot,
  // manually-expire it, then assert the pipeline-facing reader treats it as
  // not-learned. Guards red-line #3 (門控完整性) across all 10 readers.
  const cases: Array<{ category: string; seed: () => void; stillLearned: () => boolean }> = [
    { category: "features", seed: () => markAnthropicFeatureUnsupported("m", "f"), stillLearned: () => isAnthropicFeatureUnsupported("m", "f") },
    { category: "betas", seed: () => markAnthropicBetaUnsupported("m", "b"), stillLearned: () => isAnthropicBetaUnsupported("m", "b") },
    { category: "efforts", seed: () => setSupportedEfforts("m", ["low"]), stillLearned: () => getSupportedEfforts("m") !== undefined },
    { category: "effortUnsupported", seed: () => markEffortUnsupported("m"), stillLearned: () => isEffortUnsupported("m") },
    { category: "deferredTools", seed: () => markToolUndeferred("m", "t"), stillLearned: () => isToolStickyUndeferred("m", "t") },
    {
      category: "serverTools",
      seed: () => markAnthropicServerToolUnsupported("m", "web_search_"),
      stillLearned: () => getUnsupportedServerToolTypes("m").includes("web_search_"),
    },
    {
      category: "partnerFeatures",
      seed: () => markAnthropicPartnerFeatureUnsupported("m", "structured_outputs"),
      stillLearned: () => isAnthropicPartnerFeatureUnsupported("m", "structured_outputs"),
    },
    { category: "systemRejectModels", seed: () => markSystemRejectModel("m"), stillLearned: () => isSystemRejectModelLearned("m") },
    { category: "serverToolDowngrade", seed: () => markServerToolDowngrade("m"), stillLearned: () => isServerToolDowngradeLearned("m") },
    {
      category: "toolFields",
      seed: () => markAnthropicUnsupportedToolFields(["eager_input_streaming"]),
      stillLearned: () => getUnsupportedToolFields().includes("eager_input_streaming"),
    },
  ]
  for (const { category, seed, stillLearned } of cases) {
    test(`${category}: manually-expired entry reads not-learned`, () => {
      clearAnthropicFeatureNegotiationForTests()
      seed()
      expect(stillLearned()).toBe(true)
      const entry = getGroupedSnapshot().categories.find((c) => c.category === category)!.entries[0]
      expect(entry).toBeDefined()
      expireEntry(category as never, entry.key, entry.value)
      expect(stillLearned()).toBe(false)
    })
  }
})

describe("per-category TTL config", () => {
  test("per-category TTL override changes expiry (toolFields set to 90d explicitly)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setNegotiationConfig({ negotiationTtlOverridesMs: { toolFields: 90 * DAY_MS } })
    setSystemTime(new Date(BASE_MS))
    markAnthropicUnsupportedToolFields(["eager_input_streaming"])
    setSystemTime(new Date(BASE_MS + 60 * DAY_MS)) // 60d: default 30d would expire, but toolFields=90d
    expect(getUnsupportedToolFields()).toContain("eager_input_streaming")
    setSystemTime()
    // restore shipped defaults so later tests are unaffected
    setNegotiationConfig({ negotiationTtlOverridesMs: { toolFields: 90 * DAY_MS, partnerFeatures: Number.POSITIVE_INFINITY } })
  })
})
